// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {ISwapVM} from "swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "swap-vm/src/libs/TakerTraits.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {FlashArbTestBase} from "./base/FlashArbTestBase.sol";

contract FlashArbExecutorTest is FlashArbTestBase {
    /// @dev The Aqua strategy holds 100 WETH and 290,000 USDC, so it sells WETH at 2,900 USDC; v4 pays 3,000.
    uint256 internal constant AQUA_WETH = 100e18;
    uint256 internal constant AQUA_USDC = 290_000e6;
    uint128 internal constant SIZE = 0.1e18;

    function test_flowA_keepsProfitAsClaim() public {
        (ISwapVM.Order memory order, bytes32 strategyHash) = _shipXYC(AQUA_WETH, AQUA_USDC);

        executor.arb(_arbParams(order, SIZE, 1, true));
        uint256 gasUsed = vm.snapshotGasLastFrame("FlashArbExecutor", "flowA_profitAsClaim");

        (uint256 aquaWeth, uint256 aquaUsdc) = _aquaBalances(strategyHash);
        uint256 usdcIn = aquaUsdc - AQUA_USDC;
        uint256 wethOut = AQUA_WETH - aquaWeth;
        assertEq(wethOut, AQUA_WETH * usdcIn / (AQUA_USDC + usdcIn), "Aqua paid its constant-product price");

        uint256 profit = _wethClaims(address(executor));
        assertEq(profit, wethOut - SIZE, "profit is the WETH bought back minus the WETH sold");
        assertGt(profit, 0, "the arb made money");
        assertEq(weth.balanceOf(address(executor)), 0, "executor holds no WETH");
        assertEq(usdc.balanceOf(address(executor)), 0, "executor holds no USDC");
        console2.log("Flow A, profit as claim: gas %d, profit %d wei", gasUsed, profit);
    }

    function test_flowA_paysProfitToOwner() public {
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_USDC);
        uint256 before = weth.balanceOf(address(this));

        executor.arb(_arbParams(order, SIZE, 1, false));
        uint256 gasUsed = vm.snapshotGasLastFrame("FlashArbExecutor", "flowA_profitAsTake");

        assertGt(weth.balanceOf(address(this)), before, "owner received WETH");
        assertEq(_wethClaims(address(executor)), 0, "no claims minted");
        console2.log("Flow A, profit taken: gas %d", gasUsed);
    }

    function test_withdrawClaim() public {
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_USDC);
        executor.arb(_arbParams(order, SIZE, 1, true));
        uint256 claim = _wethClaims(address(executor));
        uint256 before = weth.balanceOf(address(this));

        executor.withdrawClaim(Currency.wrap(address(weth)), claim, address(this));

        assertEq(weth.balanceOf(address(this)), before + claim, "owner received the claimed WETH");
        assertEq(_wethClaims(address(executor)), 0, "claims burned");
    }

    function test_revertsWhenUnprofitable() public {
        // Same price on both venues: the 0.3% v4 fee makes the round trip lose.
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_WETH * V4_USDC_PER_WETH / 1e18);
        FlashArbExecutor.Arb memory p = _arbParams(order, SIZE, 1, true);

        vm.expectPartialRevert(FlashArbExecutor.InsufficientProfit.selector);
        executor.arb(p);
    }

    /// @dev The first arb creates the executor's claim slot. From the second arb on, minting into a non-zero slot
    ///      is cheaper than transferring the profit out, so steady-state arbs should keep profit as a claim.
    function test_gas_steadyStateClaimBeatsTake() public {
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_USDC);
        executor.arb(_arbParams(order, SIZE, 1, true));
        uint256 state = vm.snapshotState();

        executor.arb(_arbParams(order, SIZE, 1, true));
        uint256 claimGas = vm.snapshotGasLastFrame("FlashArbExecutor", "flowA_secondArb_profitAsClaim");
        vm.revertToState(state);
        executor.arb(_arbParams(order, SIZE, 1, false));
        uint256 takeGas = vm.snapshotGasLastFrame("FlashArbExecutor", "flowA_secondArb_profitAsTake");

        console2.log("Second arb: claim %d gas, take %d gas", claimGas, takeGas);
        assertLt(claimGas, takeGas, "a claim into a non-zero slot is cheaper than a transfer");
    }

    /// @dev Whatever the size, the arb either profits by at least minProfit or changes nothing.
    function testFuzz_flowA_profitsOrRevertsCleanly(uint128 amountIn) public {
        amountIn = uint128(bound(amountIn, 1e12, 5e18));
        (ISwapVM.Order memory order, bytes32 strategyHash) = _shipXYC(AQUA_WETH, AQUA_USDC);
        (uint256 wethBefore, uint256 usdcBefore) = _aquaBalances(strategyHash);

        try executor.arb(_arbParams(order, amountIn, 1, true)) {
            assertGe(_wethClaims(address(executor)), 1, "a successful arb clears minProfit");
        } catch {
            (uint256 wethAfter, uint256 usdcAfter) = _aquaBalances(strategyHash);
            assertEq(wethAfter, wethBefore, "a failed arb leaves the maker's WETH untouched");
            assertEq(usdcAfter, usdcBefore, "a failed arb leaves the maker's USDC untouched");
            assertEq(_wethClaims(address(executor)), 0, "a failed arb mints nothing");
        }
        assertEq(weth.balanceOf(address(executor)), 0, "executor never holds WETH");
        assertEq(usdc.balanceOf(address(executor)), 0, "executor never holds USDC");
    }

    function test_revertsWhenExpired() public {
        vm.roll(100);
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_USDC);
        FlashArbExecutor.Arb memory p = _arbParams(order, SIZE, 1, true);
        p.lastBlock = 99;

        vm.expectRevert(abi.encodeWithSelector(FlashArbExecutor.Expired.selector, 99));
        executor.arb(p);
    }

    function test_onlyOwnerCanArb() public {
        (ISwapVM.Order memory order,) = _shipXYC(AQUA_WETH, AQUA_USDC);
        FlashArbExecutor.Arb memory p = _arbParams(order, SIZE, 1, true);

        vm.prank(address(0xBEEF));
        vm.expectRevert(FlashArbExecutor.NotOwner.selector);
        executor.arb(p);
    }

    function test_callbacksRejectStrangers() public {
        vm.expectRevert(FlashArbExecutor.NotPoolManager.selector);
        executor.unlockCallback(hex"01");

        vm.expectRevert(FlashArbExecutor.NotRouter.selector);
        executor.preTransferInCallback(maker, address(executor), address(usdc), address(weth), 1, 1, bytes32(0), "");
    }

    /// @dev The executor hard-codes the taker header; SwapVM's own builder must produce the same bytes.
    function test_takerHeaderMatchesSwapVMBuilder() public view {
        bytes memory built = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(executor),
                isExactIn: true,
                shouldUnwrapWeth: false,
                hasPreTransferInCallback: true,
                hasPreTransferOutCallback: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: false,
                threshold: "",
                to: address(manager),
                deadline: 0,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
        assertEq(built, abi.encodePacked(executor.TAKER_HEADER(), address(manager)));
    }
}
