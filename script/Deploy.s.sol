// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";

/// @notice Deploys FlashArbExecutor against existing Uniswap v4, Aqua and SwapVM contracts and records the result in
///         deployments/<chainId>.json. On Unichain (chain 130) the canonical addresses are built in; on any other
///         chain set POOL_MANAGER, AQUA and ROUTER. The broadcaster owns the executor unless OWNER is set.
///         Optional: TOKENS (comma-separated) get a max approval to Aqua; DEPLOYMENT_FILE overrides the output path.
///         It never deploys the protocols themselves; scripts/demo-chain.sh does that for a local chain.
contract Deploy is Script {
    address internal constant UNICHAIN_POOL_MANAGER = 0x1F98400000000000000000000000000000000004;
    address internal constant UNICHAIN_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address internal constant UNICHAIN_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;

    function run() external returns (FlashArbExecutor) {
        (address poolManager, address aqua, address router) = _addresses();
        address[] memory tokens = vm.envOr("TOKENS", ",", new address[](0));
        string memory file =
            vm.envOr("DEPLOYMENT_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json"));
        return deploy(poolManager, aqua, router, vm.envOr("OWNER", address(0)), tokens, file);
    }

    /// @param owner The executor's owner; address(0) means the broadcaster.
    function deploy(
        address poolManager,
        address aqua,
        address router,
        address owner,
        address[] memory tokens,
        string memory file
    ) public returns (FlashArbExecutor executor) {
        require(poolManager.code.length > 0, "PoolManager has no code on this chain");
        require(aqua.code.length > 0, "Aqua has no code on this chain");
        require(router.code.length > 0, "SwapVM router has no code on this chain");

        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        if (owner == address(0)) owner = broadcaster;
        uint256 startBlock = block.number;
        executor = new FlashArbExecutor(IPoolManager(poolManager), router, aqua, owner);
        bool approved = tokens.length != 0 && owner == broadcaster;
        if (approved) executor.approveAqua(tokens);
        vm.stopBroadcast();
        if (tokens.length != 0 && !approved) {
            console2.log("OWNER is not the broadcaster, so the Aqua approvals were skipped.");
            console2.log("Call approveAqua(tokens) from the owner before the first trade.");
        }

        vm.writeFile(
            file,
            _json(poolManager, aqua, router, address(executor), owner, startBlock, approved ? tokens : new address[](0))
        );
        console2.log("FlashArbExecutor", address(executor));
        console2.log("Owner", owner);
        console2.log("Wrote", file);
    }

    function _addresses() internal view returns (address poolManager, address aqua, address router) {
        if (block.chainid == 130) return (UNICHAIN_POOL_MANAGER, UNICHAIN_AQUA, UNICHAIN_ROUTER);
        poolManager = vm.envAddress("POOL_MANAGER");
        aqua = vm.envAddress("AQUA");
        router = vm.envAddress("ROUTER");
    }

    function _json(
        address poolManager,
        address aqua,
        address router,
        address executor,
        address owner,
        uint256 startBlock,
        address[] memory tokens
    ) internal view returns (string memory) {
        string memory list;
        for (uint256 i; i < tokens.length; ++i) {
            list = string.concat(list, i == 0 ? "" : ", ", '"', vm.toString(tokens[i]), '"');
        }
        return string.concat(
            '{\n  "chainId": ',
            vm.toString(block.chainid),
            ',\n  "startBlock": ',
            vm.toString(startBlock),
            ',\n  "poolManager": "',
            vm.toString(poolManager),
            '",\n  "aqua": "',
            vm.toString(aqua),
            '",\n  "router": "',
            vm.toString(router),
            '",\n  "executor": "',
            vm.toString(executor),
            '",\n  "owner": "',
            vm.toString(owner),
            '",\n  "approvedTokens": [',
            list,
            "]\n}\n"
        );
    }
}
