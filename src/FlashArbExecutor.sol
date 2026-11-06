// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

import {ISwapVMRouter} from "./interfaces/ISwapVMRouter.sol";

/// @title FlashArbExecutor
/// @notice Reference (Solidity) flash-arbitrage executor. It borrows through Uniswap v4 flash accounting and trades
///         against a 1inch Aqua strategy priced by SwapVM, all inside one PoolManager.unlock. The Huff build must
///         behave exactly like this contract; differential tests compare the two.
/// @dev Flow A: sell `amountIn` on the v4 pool (deltas only, no transfer), buy the same currency back from the Aqua
///      strategy with all of the v4 output, and keep the difference. Aqua pays straight into the PoolManager, and the
///      executor pays the maker from inside SwapVM's pre-transfer-in callback, so one arb moves exactly three ERC20s.
contract FlashArbExecutor is IUnlockCallback {
    using SafeTransferLib for address;

    /// @notice SwapVM v1.0.x taker-traits header for this flow: slice ends index9..index1 = 20 (a single 20-byte
    ///         `to` slice, the PoolManager), index0 = 0 (no threshold), flags = IS_EXACT_IN | HAS_PRE_TRANSFER_IN_CALLBACK.
    bytes22 public constant TAKER_HEADER = 0x00140014001400140014001400140014001400000005;

    uint8 internal constant ACTION_ARB = 1;
    uint8 internal constant ACTION_WITHDRAW = 2;

    IPoolManager public immutable POOL_MANAGER;
    address public immutable ROUTER;
    address public immutable AQUA;
    address public immutable OWNER;

    /// @param key The v4 pool of the first leg.
    /// @param zeroForOne Direction of the v4 leg: true sells key.currency0 for key.currency1.
    /// @param amountIn Exact input of the v4 leg, in the currency that is also the profit currency.
    /// @param minProfit Minimum profit in that currency; the arb reverts below it.
    /// @param lastBlock Last block number at which the arb may execute.
    /// @param profitAsClaim True keeps profit as an ERC-6909 claim in the PoolManager (saves a transfer per arb).
    /// @param order The Aqua strategy, as SwapVM's Order.
    struct Arb {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minProfit;
        uint32 lastBlock;
        bool profitAsClaim;
        ISwapVMRouter.Order order;
    }

    error NotOwner();
    error NotPoolManager();
    error NotRouter();
    error Expired(uint256 lastBlock);
    error InsufficientProfit(uint256 amountBack, uint256 amountOwed, uint256 minProfit);
    error ZeroAddress();

    constructor(IPoolManager poolManager, address router, address aqua, address owner) {
        if (address(poolManager) == address(0) || router == address(0) || aqua == address(0) || owner == address(0)) {
            revert ZeroAddress();
        }
        POOL_MANAGER = poolManager;
        ROUTER = router;
        AQUA = aqua;
        OWNER = owner;
    }

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner();
        _;
    }

    /// @notice Runs one Flow A arbitrage.
    function arb(Arb calldata p) external onlyOwner {
        if (block.number > p.lastBlock) revert Expired(p.lastBlock);
        // forge-lint: disable-next-line(unused-return)
        POOL_MANAGER.unlock(abi.encodePacked(ACTION_ARB, abi.encode(p)));
    }

    /// @notice Redeems ERC-6909 profit claims for the underlying tokens.
    function withdrawClaim(Currency currency, uint256 amount, address to) external onlyOwner {
        // forge-lint: disable-next-line(unused-return)
        POOL_MANAGER.unlock(abi.encodePacked(ACTION_WITHDRAW, abi.encode(currency, amount, to)));
    }

    /// @notice One-time max approvals so Aqua can pull this contract's payment to makers.
    function approveAqua(address[] calldata tokens) external onlyOwner {
        for (uint256 i; i < tokens.length; ++i) {
            tokens[i].safeApproveWithRetry(AQUA, type(uint256).max);
        }
    }

    /// @notice Sends out tokens that ended up here by mistake.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        if (uint8(data[0]) == ACTION_ARB) {
            _arb(abi.decode(data[1:], (Arb)));
        } else {
            (Currency currency, uint256 amount, address to) = abi.decode(data[1:], (Currency, uint256, address));
            POOL_MANAGER.burn(address(this), currency.toId(), amount);
            POOL_MANAGER.take(currency, to, amount);
        }
        return "";
    }

    /// @notice SwapVM calls this after Aqua has paid the output and before it checks the maker was paid.
    /// @dev Only swaps this contract started can call back here: SwapVM calls the swap's msg.sender.
    function preTransferInCallback(
        address maker,
        address taker,
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        bytes32 orderHash,
        bytes calldata /* takerData */
    ) external {
        if (msg.sender != ROUTER || taker != address(this)) revert NotRouter();
        // The v4 leg left a positive delta in tokenIn: take exactly what the maker is owed and push it to Aqua.
        POOL_MANAGER.take(Currency.wrap(tokenIn), address(this), amountIn);
        IAqua(AQUA).push(maker, ROUTER, orderHash, tokenIn, amountIn);
    }

    function _arb(Arb memory p) internal {
        // 1. v4 leg: exact-in sell. Nothing moves yet; the PoolManager only records deltas.
        BalanceDelta delta = POOL_MANAGER.swap(
            p.key,
            IPoolManager.SwapParams({
                zeroForOne: p.zeroForOne,
                amountSpecified: -int256(uint256(p.amountIn)),
                sqrtPriceLimitX96: p.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (Currency currencyIn, Currency currencyOut, int128 spent, int128 received) = p.zeroForOne
            ? (p.key.currency0, p.key.currency1, delta.amount0(), delta.amount1())
            : (p.key.currency1, p.key.currency0, delta.amount1(), delta.amount0());
        // An exact-in swap with a hook-free pool makes `spent` negative and `received` non-negative.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 owed = uint256(int256(-spent));

        // 2. Aqua leg: buy currencyIn back with all of the v4 output. Aqua pulls it from the maker's wallet straight
        //    into the PoolManager (the `to` slice), and settle() credits whatever arrived.
        POOL_MANAGER.sync(currencyIn);
        // forge-lint: disable-next-item(unused-return)
        ISwapVMRouter(ROUTER)
            .swap(
                p.order,
                Currency.unwrap(currencyOut),
                Currency.unwrap(currencyIn),
                // forge-lint: disable-next-line(unsafe-typecast)
                uint256(int256(received)),
                abi.encodePacked(TAKER_HEADER, address(POOL_MANAGER))
            );
        uint256 amountBack = POOL_MANAGER.settle();

        // 3. Keep the spread; the PoolManager reverts the whole transaction unless every delta is now zero.
        if (amountBack < owed + p.minProfit) revert InsufficientProfit(amountBack, owed, p.minProfit);
        uint256 profit = amountBack - owed;
        if (p.profitAsClaim) {
            POOL_MANAGER.mint(address(this), currencyIn.toId(), profit);
        } else {
            POOL_MANAGER.take(currencyIn, OWNER, profit);
        }
    }
}
