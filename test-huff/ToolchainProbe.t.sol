// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HuffConfig, HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

import {HuffTestBase} from "./base/HuffTestBase.sol";

/// @notice Milestone 0: proves the Huff toolchain works from Foundry before any executor code exists. It checks the
///         compiler version, that a Huff contract compiles, deploys and runs, that compile-time constants can be
///         overridden (the prototype executor takes its addresses that way), that the EVM version is honoured, and
///         that compiler errors surface as test failures instead of being swallowed.
contract ToolchainProbeTest is HuffTestBase {
    using HuffNeoConfig for HuffConfig;

    string internal constant PROBE = "src/huff/ToolchainProbe.huff";
    string internal constant TLOAD_FIXTURE = "test-huff/fixtures/TloadProbe.huff";

    /// @dev External wrappers so `vm.expectRevert` can see compiler failures (the library code is internal).
    function compile(string calldata file, string calldata evm) external returns (address) {
        return huffConfig().with_evm_version(evm).deploy(file);
    }

    function _answer(address probe) internal view returns (uint256) {
        (bool ok, bytes memory ret) = probe.staticcall("");
        assertTrue(ok, "the probe answers");
        return abi.decode(ret, (uint256));
    }

    function test_compilerIsThePinnedVersion() public {
        string[] memory cmd = new string[](2);
        cmd[0] = "hnc";
        cmd[1] = "--version";
        bytes memory out = vm.ffi(cmd);
        bytes memory want = bytes(string.concat("hnc ", HNC_VERSION, " "));
        assertGe(out.length, want.length, "version output is long enough");
        for (uint256 i; i < want.length; ++i) {
            assertEq(out[i], want[i], "the installed compiler is the pinned release");
        }
    }

    function test_aHuffContractCompilesDeploysAndRuns() public {
        address probe = huffConfig().deploy(PROBE);
        assertGt(probe.code.length, 0, "runtime code was deployed");
        assertEq(_answer(probe), 42, "the default constant is returned");
    }

    function test_compileTimeConstantsCanBeOverridden() public {
        address probe = huffConfig().with_uint_constant("ANSWER", 7).deploy(PROBE);
        assertEq(_answer(probe), 7, "the overridden constant is returned");
    }

    function test_theEvmVersionIsHonoured() public {
        // TLOAD exists from Cancun: it compiles for the project's EVM and is rejected for an older one.
        assertGt(this.compile(TLOAD_FIXTURE, EVM_VERSION).code.length, 0, "compiles for prague");
        vm.expectPartialRevert(HuffNeoConfig.HuffNeoCompilerError.selector);
        this.compile(TLOAD_FIXTURE, "shanghai");
    }

    function test_compilerErrorsSurface() public {
        vm.expectPartialRevert(HuffNeoConfig.HuffNeoCompilerError.selector);
        this.compile("src/huff/DoesNotExist.huff", EVM_VERSION);
    }
}
