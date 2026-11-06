// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// v4-core pins PoolManager to solc 0.8.26 while SwapVM and Aqua pin 0.8.30, so no single test file can import both.
// Importing PoolManager here compiles it as its own 0.8.26 unit; tests deploy it by artifact with `deployCode`.
// forge-lint: disable-next-line(unused-import)
import {PoolManager} from "v4-core/src/PoolManager.sol";
