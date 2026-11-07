// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {FlashArbTestBase} from "./base/FlashArbTestBase.sol";

/// @notice Tests beyond the happy path: the opposite direction, the quote-by-revert trick the bot relies on, access
///         control, callback abuse and the shape of the profit curve.
contract FlashArbHardeningTest is FlashArbTestBase {
    /// @dev Aqua sells WETH at 2,900 USDC; v4 pays 3,000. Selling WETH on v4 first is profitable.
    uint256 internal constant CHEAP_WETH = 100e18;
    uint256 internal constant CHEAP_USDC = 290_000e6;
    /// @dev Aqua pays 3,100 USDC per WETH; v4 sells WETH at 3,000. Selling USDC on v4 first is profitable.
    uint256 internal constant RICH_WETH = 100e18;
    uint256 internal constant RICH_USDC = 310_000e6;

    function _usdcClaims(address owner) internal view returns (uint256) {
        return manager.balanceOf(owner, Currency.wrap(address(usdc)).toId());
    }

    /// @dev Flow A parameters with an explicit sell side: `sellWeth` sells WETH on v4, otherwise USDC.
    function _arbDir(ISwapVM.Order memory order, bool sellWeth, uint128 amountIn, uint128 minProfit, bool claim)
        internal
        view
        returns (FlashArbExecutor.Arb memory p)
    {
        p = _arbParams(order, amountIn, minProfit, claim);
        p.zeroForOne = sellWeth ? wethIsCurrency0 : !wethIsCurrency0;
    }

    /// @dev Quotes by reverting: with an unreachable minProfit the executor always reverts with
    ///      InsufficientProfit(amountBack, amountOwed, minProfit), so profit = amountBack - amountOwed.
    ///      Returns viable = false when the revert was anything else.
    function _quote(FlashArbExecutor.Arb memory p) internal returns (int256 profit, bool viable) {
        p.minProfit = type(uint128).max;
        (bool ok, bytes memory ret) = address(executor).call(abi.encodeCall(executor.arb, (p)));
        assertFalse(ok, "a quote never succeeds");
        if (ret.length < 4 + 96 || bytes4(ret) != FlashArbExecutor.InsufficientProfit.selector) return (0, false);
        bytes memory args = new bytes(ret.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = ret[i + 4];
        }
        (uint256 back, uint256 owed,) = abi.decode(args, (uint256, uint256, uint256));
        // forge-lint: disable-next-line(unsafe-typecast)
        return (int256(back) - int256(owed), true);
    }

    // ---------------------------------------------------------------- opposite direction

    function test_reverseDirection_sellsUsdcAndKeepsUsdcClaim() public {
        (ISwapVM.Order memory order,) = _shipXYC(RICH_WETH, RICH_USDC);

        executor.arb(_arbDir(order, false, 300e6, 1, true));

        assertGt(_usdcClaims(address(executor)), 0, "profit is kept in USDC, the token that was sold");
        assertEq(_wethClaims(address(executor)), 0, "no WETH claim in the reverse direction");
        assertEq(weth.balanceOf(address(executor)), 0, "executor holds no WETH");
        assertEq(usdc.balanceOf(address(executor)), 0, "executor holds no USDC");
    }

    function test_reverseDirection_canPayProfitToOwner() public {
        (ISwapVM.Order memory order,) = _shipXYC(RICH_WETH, RICH_USDC);
        uint256 before = usdc.balanceOf(address(this));

        executor.arb(_arbDir(order, false, 300e6, 1, false));

        assertGt(usdc.balanceOf(address(this)), before, "owner received USDC");
        assertEq(_usdcClaims(address(executor)), 0, "no claim minted");
    }

    function test_wrongDirectionLoses() public {
        // Aqua sells WETH cheap, so selling USDC on v4 first is the losing direction.
        (ISwapVM.Order memory order,) = _shipXYC(CHEAP_WETH, CHEAP_USDC);
        FlashArbExecutor.Arb memory p = _arbDir(order, false, 300e6, 1, true);

        vm.expectPartialRevert(FlashArbExecutor.InsufficientProfit.selector);
        executor.arb(p);
    }

    // ---------------------------------------------------------------- quote by revert

    function _assertQuoteMatchesRealProfit(bool sellWeth, uint128 size, uint256 snapshot) internal {
        (ISwapVM.Order memory order,) = (sellWeth ? _shipXYC(CHEAP_WETH, CHEAP_USDC) : _shipXYC(RICH_WETH, RICH_USDC));
        (int256 quoted, bool viable) = _quote(_arbDir(order, sellWeth, size, 0, true));
        assertTrue(viable, "the quote decoded");
        assertGt(quoted, 0, "this size is profitable");

        executor.arb(_arbDir(order, sellWeth, size, 1, true));
        uint256 realized = sellWeth ? _wethClaims(address(executor)) : _usdcClaims(address(executor));
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(realized, uint256(quoted), "the quote equals the profit a real arb books");
        vm.revertToState(snapshot);
    }

    function test_quoteByRevert_matchesRealProfit_sellWeth() public {
        uint256 snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(true, 0.05e18, snapshot);
        snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(true, 0.2e18, snapshot);
        snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(true, 1e18, snapshot);
    }

    function test_quoteByRevert_matchesRealProfit_sellUsdc() public {
        uint256 snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(false, 150e6, snapshot);
        snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(false, 600e6, snapshot);
        snapshot = vm.snapshotState();
        _assertQuoteMatchesRealProfit(false, 3_000e6, snapshot);
    }

    function test_quoteByRevert_isNegativeWhenUnprofitable() public {
        // Same price on both venues: the 0.3% v4 fee makes the round trip lose.
        (ISwapVM.Order memory order,) = _shipXYC(CHEAP_WETH, CHEAP_WETH * V4_USDC_PER_WETH / 1e18);
        (int256 quoted, bool viable) = _quote(_arbDir(order, true, 0.1e18, 0, true));
        assertTrue(viable, "an unprofitable arb still quotes");
        assertLt(quoted, 0, "the quote is a loss");
    }

    function test_quoteByRevert_changesNothing() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _shipXYC(CHEAP_WETH, CHEAP_USDC);
        (uint256 wethBefore, uint256 usdcBefore) = _aquaBalances(strategyHash);

        _quote(_arbDir(order, true, 1e18, 0, true));

        (uint256 wethAfter, uint256 usdcAfter) = _aquaBalances(strategyHash);
        assertEq(wethAfter, wethBefore, "a quote leaves Aqua's WETH alone");
        assertEq(usdcAfter, usdcBefore, "a quote leaves Aqua's USDC alone");
        assertEq(_wethClaims(address(executor)), 0, "a quote mints nothing");
    }

    // ---------------------------------------------------------------- size curve

    /// @dev Profit rises to one peak and then falls as size grows, which is what lets the bot use a golden-section
    ///      search over amountIn instead of a scan.
    function test_sizeCurve_hasASinglePeak() public {
        (ISwapVM.Order memory order,) = _shipXYC(CHEAP_WETH, CHEAP_USDC);
        uint128[7] memory sizes = [uint128(0.01e18), 0.1e18, 0.5e18, 1e18, 2e18, 5e18, 20e18];
        int256[7] memory profits;
        uint256 peak;
        for (uint256 i; i < sizes.length; ++i) {
            bool viable;
            (profits[i], viable) = _quote(_arbDir(order, true, sizes[i], 0, true));
            assertTrue(viable, "every size quotes");
            if (profits[i] > profits[peak]) peak = i;
        }
        assertGt(profits[peak], 0, "somewhere the arb pays");
        assertGt(peak, 0, "the best size is not the smallest");
        assertLt(peak, sizes.length - 1, "the best size is not the largest");
        for (uint256 i = 1; i <= peak; ++i) {
            assertGe(profits[i], profits[i - 1], "profit rises up to the peak");
        }
        for (uint256 i = peak + 1; i < sizes.length; ++i) {
            assertLe(profits[i], profits[i - 1], "profit falls after the peak");
        }
        assertLt(profits[sizes.length - 1], 0, "a huge size loses money");
    }

    // ---------------------------------------------------------------- access control

    function test_onlyOwner_forEveryAdminFunction() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        address stranger = address(0xBEEF);

        vm.startPrank(stranger);
        vm.expectRevert(FlashArbExecutor.NotOwner.selector);
        executor.withdrawClaim(Currency.wrap(address(weth)), 1, stranger);
        vm.expectRevert(FlashArbExecutor.NotOwner.selector);
        executor.approveAqua(tokens);
        vm.expectRevert(FlashArbExecutor.NotOwner.selector);
        executor.rescue(address(weth), stranger, 1);
        vm.stopPrank();
    }

    function test_rescue_movesStrayTokens() public {
        weth.mint(address(executor), 5e18);
        address to = address(0xCAFE);

        executor.rescue(address(weth), to, 5e18);

        assertEq(weth.balanceOf(to), 5e18, "tokens were rescued");
        assertEq(weth.balanceOf(address(executor)), 0, "executor is empty again");
    }

    function test_withdrawClaim_cannotExceedBalance() public {
        (ISwapVM.Order memory order,) = _shipXYC(CHEAP_WETH, CHEAP_USDC);
        executor.arb(_arbDir(order, true, 0.1e18, 1, true));
        uint256 claim = _wethClaims(address(executor));

        vm.expectRevert();
        executor.withdrawClaim(Currency.wrap(address(weth)), claim + 1, address(this));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(FlashArbExecutor.ZeroAddress.selector);
        new FlashArbExecutor(manager, address(0), address(aqua), address(this));
        vm.expectRevert(FlashArbExecutor.ZeroAddress.selector);
        new FlashArbExecutor(manager, address(router), address(0), address(this));
        vm.expectRevert(FlashArbExecutor.ZeroAddress.selector);
        new FlashArbExecutor(manager, address(router), address(aqua), address(0));
    }

    // ---------------------------------------------------------------- callback abuse

    /// @dev SwapVM calls `preTransferInCallback` on `msg.sender` of `swap` (SwapVM.sol sets query.taker = msg.sender).
    ///      So a third party that calls the router calls back its own contract, never the executor. The executor
    ///      still checks both the caller and the taker, so even a call that claims to come from the router fails
    ///      unless the taker is the executor itself.
    function test_callback_rejectsForeignTakerEvenFromRouter() public {
        vm.prank(address(router));
        vm.expectRevert(FlashArbExecutor.NotRouter.selector);
        executor.preTransferInCallback(maker, address(0xBAD), address(usdc), address(weth), 1, 1, bytes32(0), "");
    }

    function test_callback_rejectsWrongCallerEvenWithRightTaker() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(FlashArbExecutor.NotRouter.selector);
        executor.preTransferInCallback(maker, address(executor), address(usdc), address(weth), 1, 1, bytes32(0), "");
    }

    function test_unlockCallback_rejectsEverythingButThePoolManager() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(FlashArbExecutor.NotPoolManager.selector);
        executor.unlockCallback(hex"02");
    }

    // ---------------------------------------------------------------- expiry boundary

    function test_lastBlockIsInclusive() public {
        vm.roll(50);
        (ISwapVM.Order memory order,) = _shipXYC(CHEAP_WETH, CHEAP_USDC);
        FlashArbExecutor.Arb memory p = _arbDir(order, true, 0.1e18, 1, true);
        p.lastBlock = 50;

        executor.arb(p);

        assertGt(_wethClaims(address(executor)), 0, "an arb in its last block still runs");
    }
}
