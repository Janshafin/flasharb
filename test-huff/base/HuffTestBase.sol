// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HuffNeoDeployer} from "foundry-huff-neo/HuffNeoDeployer.sol";
import {HuffConfig, HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

/// @notice Shared setup for every Huff test.
/// @dev foundry-huff-neo compiles for the "osaka" EVM unless told otherwise, but this project targets "prague"
///      (foundry.toml evm_version). Every Huff compile in the tests must go through `huffConfig()` so the Huff build is
///      always compiled for the same EVM as the Solidity reference.
abstract contract HuffTestBase is Test {
    using HuffNeoConfig for HuffConfig;

    string internal constant EVM_VERSION = "prague";
    /// @dev The compiler release the project is pinned to; scripts/install-hnc.sh installs exactly this one.
    string internal constant HNC_VERSION = "1.7.1";

    function huffConfig() internal view returns (HuffConfig memory) {
        return HuffNeoDeployer.config().with_evm_version(EVM_VERSION);
    }
}
