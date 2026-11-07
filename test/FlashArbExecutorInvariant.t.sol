// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {MakerTraits} from "swap-vm/src/libs/MakerTraits.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {ISwapVMRouter} from "../src/interfaces/ISwapVMRouter.sol";
import {FlashArbTestBase} from "./base/FlashArbTestBase.sol";

/// @notice Owns its own executor and fires arbs of random size, direction and profit mode at it. It records every
///         way the executor could break its promises.
contract ArbHandler is Test {
    FlashArbExecutor public immutable executor;
    IPoolManager internal immutable manager;
    TokenMock internal immutable weth;
    TokenMock internal immutable usdc;
    PoolKey internal key;
    bool internal immutable wethIsCurrency0;
    ISwapVMRouter.Order internal cheap; // Aqua sells WETH cheap: selling WETH on v4 first pays
    ISwapVMRouter.Order internal rich; // Aqua pays a lot for WETH: selling USDC on v4 first pays

    uint256 public successes;
    uint256 public reverts;
    /// @dev Counts any arb that succeeded without clearing its minProfit, or any claim that went down.
    uint256 public violations;
    uint256 internal lastWethClaim;
    uint256 internal lastUsdcClaim;

    constructor(
        IPoolManager manager_,
        address router,
        address aqua,
        PoolKey memory key_,
        bool wethIsCurrency0_,
        TokenMock weth_,
        TokenMock usdc_,
        ISwapVMRouter.Order memory cheap_,
        ISwapVMRouter.Order memory rich_
    ) {
        manager = manager_;
        weth = weth_;
        usdc = usdc_;
        key = key_;
        wethIsCurrency0 = wethIsCurrency0_;
        cheap = cheap_;
        rich = rich_;
        executor = new FlashArbExecutor(manager_, router, aqua, address(this));
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth_);
        tokens[1] = address(usdc_);
        executor.approveAqua(tokens);
    }

    function claim(TokenMock token) public view returns (uint256) {
        return manager.balanceOf(address(executor), Currency.wrap(address(token)).toId());
    }

    function arb(uint256 pick, uint128 size, bool sellWeth, bool asClaim) external {
        TokenMock sold = sellWeth ? weth : usdc;
        // Sizes from dust to far past the profit peak, in the units of the token being sold.
        size = uint128(bound(size, sellWeth ? 1e12 : 1e3, sellWeth ? 8e18 : 24_000e6));
        FlashArbExecutor.Arb memory p = FlashArbExecutor.Arb({
            key: key,
            zeroForOne: sellWeth ? wethIsCurrency0 : !wethIsCurrency0,
            amountIn: size,
            minProfit: 1,
            lastBlock: uint32(block.number),
            profitAsClaim: asClaim,
            order: pick % 2 == 0 ? cheap : rich
        });
        uint256 claimBefore = claim(sold);
        uint256 ownerBefore = sold.balanceOf(address(this));

        try executor.arb(p) {
            ++successes;
            uint256 gained = asClaim ? claim(sold) - claimBefore : sold.balanceOf(address(this)) - ownerBefore;
            if (gained < 1) ++violations;
        } catch {
            ++reverts;
        }

        uint256 w = claim(weth);
        uint256 u = claim(usdc);
        if (w < lastWethClaim || u < lastUsdcClaim) ++violations;
        lastWethClaim = w;
        lastUsdcClaim = u;
    }
}

/// forge-config: default.invariant.runs = 24
/// forge-config: default.invariant.depth = 20
/// forge-config: default.invariant.fail-on-revert = false
contract FlashArbInvariantTest is FlashArbTestBase {
    ArbHandler internal handler;

    function setUp() public override {
        super.setUp();
        (ISwapVM.Order memory cheap,) = _shipXYC(100e18, 290_000e6);
        (ISwapVM.Order memory rich,) = _shipXYC(100e18, 310_000e6);
        handler = new ArbHandler(
            manager,
            address(router),
            address(aqua),
            key,
            wethIsCurrency0,
            weth,
            usdc,
            ISwapVMRouter.Order({maker: cheap.maker, traits: MakerTraits.unwrap(cheap.traits), data: cheap.data}),
            ISwapVMRouter.Order({maker: rich.maker, traits: MakerTraits.unwrap(rich.traits), data: rich.data})
        );
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ArbHandler.arb.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Flash accounting means the executor never keeps a token balance of its own between transactions.
    function invariant_executorHoldsNoTokens() public view {
        FlashArbExecutor e = handler.executor();
        assertEq(weth.balanceOf(address(e)), 0, "executor holds no WETH");
        assertEq(usdc.balanceOf(address(e)), 0, "executor holds no USDC");
    }

    /// @dev A successful arb always clears minProfit, and profit claims never go down while nothing withdraws them.
    function invariant_noBrokenPromises() public view {
        assertEq(handler.violations(), 0, "a successful arb earned less than minProfit, or a claim shrank");
    }

    /// @dev The PoolManager always holds at least the claims it has issued.
    function invariant_poolManagerCoversClaims() public view {
        assertGe(weth.balanceOf(address(manager)), handler.claim(weth), "WETH claims are backed");
        assertGe(usdc.balanceOf(address(manager)), handler.claim(usdc), "USDC claims are backed");
    }

    /// @dev The handler is not vacuous: with a matching strategy and a sensible size, an arb through it succeeds and
    ///      books a claim. Checked directly because random campaigns can, by chance, hit only losing trades.
    function test_handlerCanLandAnArb() public {
        handler.arb(0, 0.1e18, true, true);
        assertEq(handler.successes(), 1, "the handler's arb succeeded");
        assertGt(handler.claim(weth), 0, "and booked a WETH claim");
        assertEq(handler.violations(), 0, "without breaking a promise");
    }
}
