// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AquaOpcodes} from "swap-vm/src/opcodes/AquaOpcodes.sol";
import {XYCSwap} from "swap-vm/src/instructions/XYCSwap.sol";
import {Controls} from "swap-vm/src/instructions/Controls.sol";
import {MakerTraits, MakerTraitsLib} from "swap-vm/src/libs/MakerTraits.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {Program, ProgramBuilder} from "swap-vm/test/utils/ProgramBuilder.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

/// @notice Shared pieces of the local demo scripts: building a constant-product Aqua strategy with SwapVM's own
///         ProgramBuilder (never hand-numbered opcodes) and pricing it off the live v4 pool.
/// @dev The opcode table does not depend on the Aqua address, so address(0) is fine for building programs.
abstract contract DemoBase is Script, AquaOpcodes {
    using ProgramBuilder for Program;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @dev Local anvil only. These are anvil's well-known default accounts 0 and 1; never use them elsewhere.
    uint256 internal constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ANVIL_KEY_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    constructor() AquaOpcodes(address(0)) {}

    modifier onlyLocal() {
        require(block.chainid == 31337, "demo scripts only run on a local chain (31337)");
        _;
    }

    /// @dev A constant-product strategy; `salt` makes each shipped strategy's hash unique.
    function _xycOrder(address maker, bytes32 salt) internal view returns (ISwapVM.Order memory) {
        Program memory program = ProgramBuilder.init(_opcodes());
        return MakerTraitsLib.build(
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
                    program.build(XYCSwap._xycSwapXD), program.build(Controls._salt, abi.encodePacked(salt))
                )
            })
        );
    }

    /// @dev USDC amount that prices `wethAmount` WETH at the pool's current price minus `gapBps` basis points,
    ///      so a strategy holding both amounts sells WETH `gapBps` cheaper than v4 pays for it.
    function _usdcForWeth(IPoolManager manager, PoolKey memory key, address weth, uint256 wethAmount, uint256 gapBps)
        internal
        view
        returns (uint256)
    {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64); // token1 per token0, Q128
        bool wethIsCurrency0 = Currency.unwrap(key.currency0) == weth;
        uint256 usdc = wethIsCurrency0
            ? Math.mulDiv(wethAmount, priceX128, 1 << 128)
            : Math.mulDiv(wethAmount, 1 << 128, priceX128);
        return usdc * (10_000 - gapBps) / 10_000;
    }
}
