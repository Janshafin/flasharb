// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import {AquaStrategyBuilders} from "swap-vm/test/base/AquaStrategyBuilders.sol";
import {TokenMockDecimals} from "swap-vm/test/mocks/TokenMockDecimals.sol";
import {AquaSwapVMRouter} from "swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits} from "swap-vm/src/libs/MakerTraits.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {FlashArbExecutor} from "../../src/FlashArbExecutor.sol";
import {ISwapVMRouter} from "../../src/interfaces/ISwapVMRouter.sol";

/// @notice A local stack of the official contracts, deployed from their pinned sources: Uniswap v4 PoolManager
///         (v4.0.0), 1inch Aqua (0.1.0) and the SwapVM v1.0.2 Aqua router. It holds a WETH/USDC v4 pool at
///         3,000 USDC per WETH, and the maker comes from SwapVM's own test builders.
abstract contract FlashArbTestBase is AquaStrategyBuilders {
    /// @dev 3,000 USDC (6 decimals) per 1 WETH (18 decimals).
    uint256 internal constant V4_USDC_PER_WETH = 3_000e6;
    /// @dev Full-range liquidity worth about 100 WETH and 300,000 USDC at the starting price.
    int256 internal constant V4_LIQUIDITY = 5.5e15;

    TokenMock internal weth;
    TokenMock internal usdc;
    IPoolManager internal manager;
    PoolModifyLiquidityTest internal liquidityRouter;
    AquaSwapVMRouter internal router;
    FlashArbExecutor internal executor;
    PoolKey internal key;
    bool internal wethIsCurrency0;

    constructor() AquaStrategyBuilders(address(aqua)) {}

    function setUp() public virtual override {
        super.setUp();
        weth = new TokenMock("Wrapped Ether", "WETH");
        usdc = new TokenMockDecimals("USD Coin", "USDC", 6);
        tokenA = weth;
        tokenB = usdc;

        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        liquidityRouter = new PoolModifyLiquidityTest(manager);
        router = new AquaSwapVMRouter(address(aqua), address(0), address(this), "SwapVM", "1.0.0");

        wethIsCurrency0 = address(weth) < address(usdc);
        key = PoolKey({
            currency0: Currency.wrap(wethIsCurrency0 ? address(weth) : address(usdc)),
            currency1: Currency.wrap(wethIsCurrency0 ? address(usdc) : address(weth)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, _sqrtPriceX96(1e18, V4_USDC_PER_WETH));

        weth.mint(address(this), 1_000e18);
        usdc.mint(address(this), 3_000_000e6);
        weth.approve(address(liquidityRouter), type(uint256).max);
        usdc.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: V4_LIQUIDITY,
                salt: 0
            }),
            ""
        );

        executor = new FlashArbExecutor(manager, address(router), address(aqua), address(this));
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        executor.approveAqua(tokens);
    }

    /// @dev sqrt(price) in Q64.96, where `wethAmount` WETH trades for `usdcAmount` USDC (raw units).
    function _sqrtPriceX96(uint256 wethAmount, uint256 usdcAmount) internal view returns (uint160) {
        (uint256 amount0, uint256 amount1) = wethIsCurrency0 ? (wethAmount, usdcAmount) : (usdcAmount, wethAmount);
        return uint160(Math.sqrt((amount1 << 192) / amount0));
    }

    /// @dev Ships a constant-product strategy; its WETH price is usdcBalance / wethBalance.
    function _shipXYC(uint256 wethBalance, uint256 usdcBalance)
        internal
        returns (ISwapVM.Order memory order, bytes32 strategyHash)
    {
        order = createStrategy(
            MakerSetup({
                balanceA: wethBalance,
                balanceB: usdcBalance,
                priceMin: 0,
                priceMax: 0,
                protocolFeeBps: 0,
                feeInBps: 0,
                protocolFeeRecipient: address(0),
                swapType: SwapType.XYC
            })
        );
        weth.mint(maker, wethBalance);
        usdc.mint(maker, usdcBalance);
        strategyHash = shipStrategy(router, order, weth, usdc, wethBalance, usdcBalance);
    }

    /// @dev Flow A parameters: sell `amountIn` WETH on v4, buy WETH back from the Aqua strategy.
    function _arbParams(ISwapVM.Order memory order, uint128 amountIn, uint128 minProfit, bool profitAsClaim)
        internal
        view
        returns (FlashArbExecutor.Arb memory)
    {
        return FlashArbExecutor.Arb({
            key: key,
            zeroForOne: wethIsCurrency0,
            amountIn: amountIn,
            minProfit: minProfit,
            lastBlock: uint32(block.number),
            profitAsClaim: profitAsClaim,
            order: ISwapVMRouter.Order({maker: order.maker, traits: MakerTraits.unwrap(order.traits), data: order.data})
        });
    }

    function _aquaBalances(bytes32 strategyHash) internal view returns (uint256 wethBalance, uint256 usdcBalance) {
        return aqua.safeBalances(maker, address(router), strategyHash, address(weth), address(usdc));
    }

    function _wethClaims(address owner) internal view returns (uint256) {
        return manager.balanceOf(owner, Currency.wrap(address(weth)).toId());
    }
}
