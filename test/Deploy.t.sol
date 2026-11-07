// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DemoSetup} from "../script/DemoSetup.s.sol";

/// @notice Runs the generic deploy script against the demo stack and checks the wiring and the record it writes.
/// @dev Calls `deploy(...)` directly instead of `run()`: forge runs tests in parallel and env vars are process-wide.
contract DeployScriptTest is Test {
    function _tokens(DemoSetup.Demo memory d) internal pure returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = d.weth;
        tokens[1] = d.usdc;
    }

    function test_deploysAgainstExistingContractsAndWritesARecord() public {
        DemoSetup.Demo memory d = new DemoSetup().deploy();
        string memory file = "deployments/_deploy-test-a.json";

        FlashArbExecutor e = new Deploy().deploy(d.poolManager, d.aqua, d.router, DEFAULT_SENDER, _tokens(d), file);

        assertEq(e.OWNER(), DEFAULT_SENDER, "the broadcaster owns the executor");
        assertEq(address(e.POOL_MANAGER()), d.poolManager, "PoolManager wired");
        assertEq(e.ROUTER(), d.router, "router wired");
        assertEq(e.AQUA(), d.aqua, "Aqua wired");
        assertEq(IERC20(d.weth).allowance(address(e), d.aqua), type(uint256).max, "WETH approved to Aqua");
        assertEq(IERC20(d.usdc).allowance(address(e), d.aqua), type(uint256).max, "USDC approved to Aqua");
        string memory json = vm.readFile(file);
        assertEq(vm.parseJsonAddress(json, ".executor"), address(e), "record names the executor");
        assertEq(vm.parseJsonAddress(json, ".approvedTokens[1]"), d.usdc, "record lists approved tokens");
        vm.removeFile(file);
    }

    function test_ownerDefaultsToTheBroadcaster() public {
        DemoSetup.Demo memory d = new DemoSetup().deploy();
        string memory file = "deployments/_deploy-test-b.json";

        FlashArbExecutor e = new Deploy().deploy(d.poolManager, d.aqua, d.router, address(0), _tokens(d), file);

        assertEq(e.OWNER(), DEFAULT_SENDER, "address(0) means the broadcaster");
        vm.removeFile(file);
    }

    function test_skipsApprovalsWhenOwnerIsNotTheBroadcaster() public {
        DemoSetup.Demo memory d = new DemoSetup().deploy();
        string memory file = "deployments/_deploy-test-c.json";

        FlashArbExecutor e = new Deploy().deploy(d.poolManager, d.aqua, d.router, address(0xA11CE), _tokens(d), file);

        assertEq(e.OWNER(), address(0xA11CE), "the OWNER argument wins");
        assertEq(IERC20(d.weth).allowance(address(e), d.aqua), 0, "no approval was attempted");
        assertEq(vm.parseJsonAddressArray(vm.readFile(file), ".approvedTokens").length, 0, "record lists none");
        vm.removeFile(file);
    }

    function test_refusesAddressesWithoutCode() public {
        Deploy script = new Deploy();
        address[] memory none = new address[](0);
        vm.expectRevert("PoolManager has no code on this chain");
        script.deploy(address(0xdead), address(0xdead), address(0xdead), address(0), none, "deployments/_x.json");
    }
}
