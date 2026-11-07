// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {AquaSwapVMRouter} from "swap-vm/src/routers/AquaSwapVMRouter.sol";
import {TokenMockDecimals} from "swap-vm/test/mocks/TokenMockDecimals.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {DemoSetup} from "./DemoSetup.s.sol";

/// @notice The demo on Unichain Sepolia (chain 1301), against Uniswap's deployed v4 PoolManager. 1inch has not deployed
///         Aqua or the SwapVM router there, so this script deploys both from the pinned sources, plus test WETH and USDC
///         (mock tokens, no value), a WETH/USDC pool with liquidity, the executor and an Aqua strategy priced below the
///         pool. The broadcaster (your keystore account) is both the executor's owner and the strategy's maker; no
///         well-known key is used on the public network.
///
///   forge script script/TestnetSetup.s.sol:TestnetSetup --rpc-url https://sepolia.unichain.org --account <name> --broadcast
contract TestnetSetup is DemoSetup {
    /// @dev Uniswap v4 PoolManager on Unichain Sepolia.
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x00B036B58a818B1BC34d502D3fE730Db729e62AC);

    function run() external override {
        require(block.chainid == 1301, "TestnetSetup only runs on Unichain Sepolia (1301)");
        require(address(POOL_MANAGER).code.length > 0, "no PoolManager at the expected address");
        Demo memory d = deployTestnet();
        vm.writeFile("deployments/1301.json", _json(d));
        console2.log("Wrote deployments/1301.json");
        console2.log("Executor", d.executor);
        console2.log("Owner and maker", d.owner);
    }

    function deployTestnet() public returns (Demo memory d) {
        vm.startBroadcast();
        (, d.owner,) = vm.readCallers();
        d.maker = d.owner;
        d.startBlock = block.number;
        d.poolManager = address(POOL_MANAGER);

        Aqua aqua = new Aqua();
        d.aqua = address(aqua);
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), d.owner, "SwapVM", "1.0.0");
        d.router = address(router);
        TokenMock weth = new TokenMock("flasharb test WETH", "WETH");
        TokenMock usdc = new TokenMockDecimals("flasharb test USDC", "USDC", 6);
        d.weth = address(weth);
        d.usdc = address(usdc);

        bool wethIsCurrency0 = d.weth < d.usdc;
        d.key = PoolKey({
            currency0: Currency.wrap(wethIsCurrency0 ? d.weth : d.usdc),
            currency1: Currency.wrap(wethIsCurrency0 ? d.usdc : d.weth),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        (uint256 amount0, uint256 amount1) =
            wethIsCurrency0 ? (uint256(1e18), START_PRICE_USDC_PER_WETH) : (START_PRICE_USDC_PER_WETH, uint256(1e18));
        POOL_MANAGER.initialize(d.key, uint160(Math.sqrt((amount1 << 192) / amount0)));

        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(POOL_MANAGER);
        weth.mint(d.owner, 1_000e18);
        usdc.mint(d.owner, 3_000_000e6);
        weth.approve(address(liquidityRouter), type(uint256).max);
        usdc.approve(address(liquidityRouter), type(uint256).max);
        liquidityRouter.modifyLiquidity(
            d.key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(60),
                tickUpper: TickMath.maxUsableTick(60),
                liquidityDelta: V4_LIQUIDITY,
                salt: 0
            }),
            ""
        );

        FlashArbExecutor executor = new FlashArbExecutor(POOL_MANAGER, address(router), address(aqua), d.owner);
        d.executor = address(executor);
        address[] memory tokens = new address[](2);
        tokens[0] = d.weth;
        tokens[1] = d.usdc;
        executor.approveAqua(tokens);

        // The strategy: Aqua sells WETH GAP_BPS below the pool. Same account as maker, so the spread is test tokens
        // moving between our own contracts; what the run proves is that the calls work on a public chain.
        uint256 usdcBalance = _usdcForWeth(POOL_MANAGER, d.key, d.weth, AQUA_WETH, GAP_BPS);
        weth.mint(d.maker, AQUA_WETH);
        usdc.mint(d.maker, usdcBalance);
        d.order = _xycOrder(d.maker, keccak256(abi.encode(block.number, "unichain-sepolia")));
        weth.approve(d.aqua, type(uint256).max);
        usdc.approve(d.aqua, type(uint256).max);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = AQUA_WETH;
        amounts[1] = usdcBalance;
        d.strategyHash = IAqua(d.aqua).ship(d.router, abi.encode(d.order), tokens, amounts);
        vm.stopBroadcast();
    }
}
