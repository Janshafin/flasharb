// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ISwapVMRouter
/// @notice The parts of 1inch's deployed SwapVM router (release v1.0.x, 0x111111338c5091E8440b67B168bAe16a668AC0De)
///         that flasharb calls. v1.0.x takes tokenIn and tokenOut explicitly; the 3-argument `swap` on swap-vm `main`
///         is a different ABI and is not deployed.
interface ISwapVMRouter {
    /// @dev ABI-identical to ISwapVM.Order; MakerTraits is a uint256 user-defined value type.
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }

    function swap(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function quote(
        Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bytes calldata takerTraitsAndData
    ) external view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function hash(Order calldata order) external view returns (bytes32);
}
