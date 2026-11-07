// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/Script.sol";
import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {DemoBase} from "./DemoBase.s.sol";

/// @notice Opens a fresh price gap on the local demo chain after the bot has closed the last one: the maker ships a
///         new Aqua strategy that sells WETH `GAP_BPS` (default 340) below the pool's current price.
///         Reads deployments/31337.json written by DemoSetup. Run it through scripts/reseed.sh.
contract Reseed is DemoBase {
    function run() external onlyLocal {
        string memory file = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(file);
        address aqua = vm.parseJsonAddress(json, ".aqua");
        address router = vm.parseJsonAddress(json, ".router");
        IPoolManager manager = IPoolManager(vm.parseJsonAddress(json, ".poolManager"));
        TokenMock weth = TokenMock(vm.parseJsonAddress(json, ".tokens.weth.address"));
        TokenMock usdc = TokenMock(vm.parseJsonAddress(json, ".tokens.usdc.address"));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(json, ".pools[0].key.currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(json, ".pools[0].key.currency1")),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        uint256 gapBps = vm.envOr("GAP_BPS", uint256(340));
        uint256 wethAmount = vm.envOr("AQUA_WETH", uint256(100e18));
        uint256 makerKey = vm.envOr("MAKER_PRIVATE_KEY", ANVIL_KEY_1);
        uint256 minterKey = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY_0);
        address maker = vm.addr(makerKey);
        uint256 usdcAmount = _usdcForWeth(manager, key, address(weth), wethAmount, gapBps);

        // The mock tokens are owned by the deployer, so the deployer funds the maker.
        vm.startBroadcast(minterKey);
        weth.mint(maker, wethAmount);
        usdc.mint(maker, usdcAmount);
        vm.stopBroadcast();

        vm.startBroadcast(makerKey);
        weth.approve(aqua, type(uint256).max);
        usdc.approve(aqua, type(uint256).max);
        ISwapVM.Order memory order = _xycOrder(maker, keccak256(abi.encode(block.number, block.timestamp, "reseed")));
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = wethAmount;
        amounts[1] = usdcAmount;
        bytes32 hash = IAqua(aqua).ship(router, abi.encode(order), tokens, amounts);
        vm.stopBroadcast();

        console2.log("Shipped a new Aqua strategy, hash");
        console2.logBytes32(hash);
        console2.log("WETH", wethAmount, "USDC", usdcAmount);
    }
}
