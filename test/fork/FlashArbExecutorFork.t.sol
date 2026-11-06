// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {AquaOpcodes} from "swap-vm/src/opcodes/AquaOpcodes.sol";
import {XYCSwap} from "swap-vm/src/instructions/XYCSwap.sol";
import {Controls} from "swap-vm/src/instructions/Controls.sol";
import {MakerTraits, MakerTraitsLib} from "swap-vm/src/libs/MakerTraits.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {Program, ProgramBuilder} from "swap-vm/test/utils/ProgramBuilder.sol";
import {TokenMockDecimals} from "swap-vm/test/mocks/TokenMockDecimals.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {FlashArbExecutor} from "../../src/FlashArbExecutor.sol";
import {ISwapVMRouter} from "../../src/interfaces/ISwapVMRouter.sol";

/// @notice Runs Flow A against the canonical Unichain addresses of the Uniswap v4 PoolManager, Aqua and the SwapVM
///         v1.0.x router. Tokens and the v4 pool are created in the test, so it checks the deployed ABIs and wiring
///         rather than live prices. With UNICHAIN_RPC_URL set it forks Unichain and uses the real deployments;
///         without it, it rehearses locally by deploying the official sources at those same addresses.
contract FlashArbExecutorForkTest is Test, AquaOpcodes {
    using ProgramBuilder for Program;

    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x1F98400000000000000000000000000000000004);
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;

    uint256 internal constant AQUA_WETH = 100e18;
    uint256 internal constant AQUA_USDC = 290_000e6;

    bool internal forked;
    address internal maker = makeAddr("maker");
    TokenMock internal weth;
    TokenMock internal usdc;
    FlashArbExecutor internal executor;
    PoolKey internal key;
    bool internal wethIsCurrency0;
    ISwapVM.Order internal order;

    constructor() AquaOpcodes(AQUA) {}

    function setUp() public {
        string memory rpc = vm.envOr("UNICHAIN_RPC_URL", string(""));
        if (bytes(rpc).length != 0) {
            vm.createSelectFork(rpc);
            forked = true;
        } else {
            deployCodeTo("PoolManager.sol:PoolManager", abi.encode(address(this)), address(POOL_MANAGER));
            deployCodeTo("Aqua.sol:Aqua", AQUA);
            deployCodeTo(
                "AquaSwapVMRouter.sol:AquaSwapVMRouter",
                abi.encode(AQUA, address(0), address(this), "SwapVM", "1.0.0"),
                ROUTER
            );
        }

        weth = new TokenMock("Wrapped Ether", "WETH");
        usdc = new TokenMockDecimals("USD Coin", "USDC", 6);
        wethIsCurrency0 = address(weth) < address(usdc);

        // A fresh v4 pool at 3,000 USDC per WETH on the canonical PoolManager.
        key = PoolKey({
            currency0: Currency.wrap(wethIsCurrency0 ? address(weth) : address(usdc)),
            currency1: Currency.wrap(wethIsCurrency0 ? address(usdc) : address(weth)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        (uint256 amount0, uint256 amount1) = wethIsCurrency0 ? (uint256(1e18), uint256(3_000e6)) : (3_000e6, 1e18);
        POOL_MANAGER.initialize(key, uint160(Math.sqrt((amount1 << 192) / amount0)));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(POOL_MANAGER);
        weth.mint(address(this), 1_000e18);
        usdc.mint(address(this), 3_000_000e6);
        weth.approve(address(liquidityRouter), type(uint256).max);
        usdc.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: 5.5e15,
                salt: 0
            }),
            ""
        );

        // A constant-product Aqua strategy at 2,900 USDC per WETH, shipped to the canonical router.
        Program memory program = ProgramBuilder.init(_opcodes());
        order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                receiver: address(0),
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: bytes.concat(
                    program.build(XYCSwap._xycSwapXD), program.build(Controls._salt, abi.encodePacked(block.number))
                )
            })
        );
        weth.mint(maker, AQUA_WETH);
        usdc.mint(maker, AQUA_USDC);
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = AQUA_WETH;
        amounts[1] = AQUA_USDC;
        vm.startPrank(maker);
        weth.approve(AQUA, type(uint256).max);
        usdc.approve(AQUA, type(uint256).max);
        IAqua(AQUA).ship(ROUTER, abi.encode(order), tokens, amounts);
        vm.stopPrank();

        executor = new FlashArbExecutor(POOL_MANAGER, ROUTER, AQUA, address(this));
        executor.approveAqua(tokens);
    }

    function test_flowA_onCanonicalAddresses() public {
        console2.log(forked ? "Mode: Unichain fork" : "Mode: local rehearsal (set UNICHAIN_RPC_URL to fork)");
        assertGt(address(POOL_MANAGER).code.length, 0, "PoolManager is deployed");
        assertGt(ROUTER.code.length, 0, "SwapVM router is deployed");
        assertGt(AQUA.code.length, 0, "Aqua is deployed");

        executor.arb(
            FlashArbExecutor.Arb({
                key: key,
                zeroForOne: wethIsCurrency0,
                amountIn: 0.1e18,
                minProfit: 1,
                lastBlock: uint32(block.number),
                profitAsClaim: true,
                order: ISwapVMRouter.Order({
                    maker: order.maker, traits: MakerTraits.unwrap(order.traits), data: order.data
                })
            })
        );
        uint256 profit = POOL_MANAGER.balanceOf(address(executor), Currency.wrap(address(weth)).toId());
        assertGt(profit, 0, "the arb made money on the canonical contracts");
        console2.log("Fork Flow A profit (wei)", profit);
    }
}
