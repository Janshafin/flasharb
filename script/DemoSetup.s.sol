// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {AquaSwapVMRouter} from "swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits} from "swap-vm/src/libs/MakerTraits.sol";
import {TokenMockDecimals} from "swap-vm/test/mocks/TokenMockDecimals.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {DemoBase} from "./DemoBase.s.sol";

/// @notice Builds the whole stack on a local chain and opens a real price gap: the official Uniswap v4 PoolManager
///         (deployed by artifact because it pins solc 0.8.26), 1inch Aqua, the SwapVM Aqua router, mock WETH and USDC,
///         a 0.3% WETH/USDC pool at 3,000 USDC per WETH, an Aqua strategy that sells WETH at about 2,900, and the
///         FlashArbExecutor. Run it through scripts/demo-chain.sh.
contract DemoSetup is DemoBase {
    uint256 internal constant START_PRICE_USDC_PER_WETH = 3_000e6;
    int256 internal constant V4_LIQUIDITY = 5.5e15; // about 100 WETH and 300,000 USDC at the start price
    uint256 internal constant AQUA_WETH = 100e18;
    uint256 internal constant GAP_BPS = 340; // Aqua sells WETH 3.4% below v4

    struct Demo {
        address poolManager;
        address aqua;
        address router;
        address executor;
        address weth;
        address usdc;
        address owner;
        address maker;
        PoolKey key;
        ISwapVM.Order order;
        bytes32 strategyHash;
        uint256 startBlock;
    }

    function run() external virtual {
        Demo memory d = deploy();
        string memory file = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeFile(file, _json(d));
        console2.log("Wrote", file);
        console2.log("Executor", d.executor);
        console2.log("Pool manager", d.poolManager);
    }

    function deploy() public onlyLocal returns (Demo memory d) {
        uint256 ownerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY_0);
        uint256 makerKey = vm.envOr("MAKER_PRIVATE_KEY", ANVIL_KEY_1);
        d.owner = vm.addr(ownerKey);
        d.maker = vm.addr(makerKey);
        d.startBlock = block.number;

        vm.startBroadcast(ownerKey);
        IPoolManager manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(d.owner)));
        d.poolManager = address(manager);
        Aqua aqua = new Aqua();
        d.aqua = address(aqua);
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), d.owner, "SwapVM", "1.0.0");
        d.router = address(router);

        TokenMock weth = new TokenMock("Wrapped Ether", "WETH");
        TokenMock usdc = new TokenMockDecimals("USD Coin", "USDC", 6);
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
        manager.initialize(d.key, uint160(Math.sqrt((amount1 << 192) / amount0)));

        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(manager);
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

        FlashArbExecutor executor = new FlashArbExecutor(manager, address(router), address(aqua), d.owner);
        d.executor = address(executor);
        address[] memory tokens = new address[](2);
        tokens[0] = d.weth;
        tokens[1] = d.usdc;
        executor.approveAqua(tokens);

        // Fund the maker for this strategy and for later reseeds.
        uint256 usdcBalance = _usdcForWeth(manager, d.key, d.weth, AQUA_WETH, GAP_BPS);
        weth.mint(d.maker, AQUA_WETH * 10);
        usdc.mint(d.maker, usdcBalance * 10);
        vm.stopBroadcast();

        vm.startBroadcast(makerKey);
        d.order = _xycOrder(d.maker, keccak256(abi.encode(block.number, "demo")));
        weth.approve(d.aqua, type(uint256).max);
        usdc.approve(d.aqua, type(uint256).max);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = AQUA_WETH;
        amounts[1] = usdcBalance;
        d.strategyHash = IAqua(d.aqua).ship(d.router, abi.encode(d.order), tokens, amounts);
        vm.stopBroadcast();
    }

    function _json(Demo memory d) internal view returns (string memory) {
        string memory addrs = string.concat(
            '  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "rpcUrl": "http://127.0.0.1:8545",\n  "startBlock": ',
            vm.toString(d.startBlock),
            ',\n  "poolManager": "',
            vm.toString(d.poolManager),
            '",\n  "aqua": "',
            vm.toString(d.aqua),
            '",\n  "router": "',
            vm.toString(d.router),
            '",\n  "executor": "',
            vm.toString(d.executor),
            '",\n  "owner": "',
            vm.toString(d.owner),
            '",\n  "maker": "',
            vm.toString(d.maker),
            '",\n'
        );
        string memory tokens = string.concat(
            '  "tokens": {\n    "weth": { "address": "',
            vm.toString(d.weth),
            '", "decimals": 18, "symbol": "WETH" },\n    "usdc": { "address": "',
            vm.toString(d.usdc),
            '", "decimals": 6, "symbol": "USDC" }\n  },\n'
        );
        string memory pools = string.concat(
            '  "pools": [\n    { "symbol": "WETH/USDC", "key": { "currency0": "',
            vm.toString(Currency.unwrap(d.key.currency0)),
            '", "currency1": "',
            vm.toString(Currency.unwrap(d.key.currency1)),
            '", "fee": 3000, "tickSpacing": 60, "hooks": "',
            vm.toString(address(0)),
            '" } }\n  ],\n'
        );
        string memory strategy = string.concat(
            '  "demoStrategy": {\n    "strategyHash": "',
            vm.toString(d.strategyHash),
            '",\n    "order": { "maker": "',
            vm.toString(d.order.maker),
            '", "traits": "',
            vm.toString(MakerTraits.unwrap(d.order.traits)),
            '", "data": "',
            vm.toString(d.order.data),
            '" }\n  }\n'
        );
        return string.concat("{\n", addrs, tokens, pools, strategy, "}\n");
    }
}
