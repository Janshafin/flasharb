// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HuffConfig, HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {DifferentialBase} from "./base/DifferentialBase.sol";

/// @notice Milestone 1: the Huff executor's shell compared against the Solidity reference, call by call.
/// @dev Covers the getters, the dispatcher and rescue; ExecutorApproveAqua.t.sol covers approveAqua and malformed calldata. It does not touch the PoolManager.
contract ExecutorShellTest is DifferentialBase {
    using HuffNeoConfig for HuffConfig;

    // ================================================================== getters

    function _getterSelectors() internal view returns (bytes4[5] memory) {
        return [
            solRef.OWNER.selector,
            solRef.POOL_MANAGER.selector,
            solRef.ROUTER.selector,
            solRef.AQUA.selector,
            solRef.TAKER_HEADER.selector
        ];
    }

    function test_getters_returnTheSameBytesAsTheReference() public {
        bytes4[5] memory sels = _getterSelectors();
        for (uint256 i; i < sels.length; ++i) {
            for (uint256 who; who < 3; ++who) {
                Obs memory s = _diffSame(_caller(who), 0, abi.encodePacked(sels[i]), "getter");
                assertTrue(s.ok, "a getter succeeds");
                assertEq(s.ret.length, 32, "a getter returns one word");
            }
        }
    }

    function test_getters_returnTheConfiguredValues() public {
        (bool ok, bytes memory ret) = huff.staticcall(abi.encodePacked(solRef.OWNER.selector));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), owner, "OWNER");
        (ok, ret) = huff.staticcall(abi.encodePacked(solRef.POOL_MANAGER.selector));
        assertEq(abi.decode(ret, (address)), poolManager, "POOL_MANAGER");
        (ok, ret) = huff.staticcall(abi.encodePacked(solRef.ROUTER.selector));
        assertEq(abi.decode(ret, (address)), router, "ROUTER");
        (ok, ret) = huff.staticcall(abi.encodePacked(solRef.AQUA.selector));
        assertEq(abi.decode(ret, (address)), aqua, "AQUA");
        (ok, ret) = huff.staticcall(abi.encodePacked(solRef.TAKER_HEADER.selector));
        assertEq(ret, abi.encode(solRef.TAKER_HEADER()), "TAKER_HEADER is the same 22 bytes, right-padded");
        assertEq(bytes22(abi.decode(ret, (bytes32))), solRef.TAKER_HEADER(), "and decodes to the reference's constant");
    }

    function test_getters_ignoreTrailingCalldata() public {
        bytes4[5] memory sels = _getterSelectors();
        for (uint256 i; i < sels.length; ++i) {
            _diffSame(stranger, 0, abi.encodePacked(sels[i], hex"deadbeef", uint256(7)), "getter with trailing bytes");
        }
    }

    function test_getters_rejectEther() public {
        bytes4[5] memory sels = _getterSelectors();
        for (uint256 i; i < sels.length; ++i) {
            Obs memory s = _diffSame(stranger, 1 wei, abi.encodePacked(sels[i]), "getter with ETH");
            assertFalse(s.ok, "nothing is payable");
            assertEq(s.ret.length, 0, "and it reverts with no data");
        }
    }

    function test_withoutOverridesTheHuffBuildHasZeroAddresses() public {
        // A build that forgets the compile-time constants is visibly wrong: every address is zero.
        address bare = huffConfig().deploy(HUFF_FILE);
        (bool ok, bytes memory ret) = bare.staticcall(abi.encodePacked(solRef.OWNER.selector));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), address(0), "OWNER defaults to zero");
        (ok, ret) = bare.staticcall(abi.encodePacked(solRef.AQUA.selector));
        assertEq(abi.decode(ret, (address)), address(0), "AQUA defaults to zero");
    }

    // ================================================================== dispatcher

    function _isImplemented(bytes4 sel) internal view returns (bool) {
        bytes4[5] memory g = _getterSelectors();
        for (uint256 i; i < g.length; ++i) {
            if (sel == g[i]) return true;
        }
        return sel == solRef.rescue.selector || sel == solRef.approveAqua.selector;
    }

    function _isMilestone2Or3(bytes4 sel) internal view returns (bool) {
        return sel == solRef.arb.selector || sel == solRef.withdrawClaim.selector
            || sel == solRef.unlockCallback.selector || sel == solRef.preTransferInCallback.selector;
    }

    function testFuzz_unknownSelectorsRevertWithNoData(bytes4 sel, bytes calldata extra, uint8 who, bool withEther)
        public
    {
        vm.assume(!_isImplemented(sel) && !_isMilestone2Or3(sel));
        Obs memory s = _diffSame(_caller(who), withEther ? 1 : 0, abi.encodePacked(sel, extra), "unknown selector");
        assertFalse(s.ok);
        assertEq(s.ret.length, 0);
    }

    function testFuzz_callsShorterThanASelectorRevert(bytes calldata data, bool withEther) public {
        vm.assume(data.length < 4);
        Obs memory s = _diffSame(stranger, withEther ? 1 : 0, data, "calldata shorter than 4 bytes");
        assertFalse(s.ok);
        assertEq(s.ret.length, 0);
    }

    function test_aPlainEtherTransferReverts() public {
        Obs memory s = _diffSame(stranger, 5 wei, "", "plain ETH transfer");
        assertFalse(s.ok);
        assertEq(huff.balance, 0, "no ETH is kept");
    }

    /// @dev Milestone 1 stops here on purpose. The reference does real work for these four; the Huff build does not
    ///      implement them yet and reverts with no data. This is the documented gap closed in milestones 2 and 3.
    function test_milestone1Gap_unimplementedSelectorsRevertWithNoData() public {
        bytes4[4] memory gap = [
            solRef.arb.selector,
            solRef.withdrawClaim.selector,
            solRef.unlockCallback.selector,
            solRef.preTransferInCallback.selector
        ];
        for (uint256 i; i < gap.length; ++i) {
            vm.prank(owner);
            (bool ok, bytes memory ret) = huff.call(abi.encodePacked(gap[i], new bytes(256)));
            assertFalse(ok, "not implemented yet");
            assertEq(ret.length, 0, "and it reverts with no data");
        }
    }

    // ================================================================== rescue

    function _rescue(address token, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(FlashArbExecutor.rescue, (token, to, amount));
    }

    function test_rescue_ownerMovesTokens() public {
        _fundBoth(KIND_STANDARD, 1000);
        Obs memory s = _diffSame(owner, 0, _rescue(_token(KIND_STANDARD), recipient, 400), "rescue 400 of 1000");
        assertTrue(s.ok);
        assertEq(s.ret.length, 0, "rescue returns nothing");
    }

    function test_rescue_movesTheWholeBalanceAndZero() public {
        _fundBoth(KIND_STANDARD, 1000);
        _diffSame(owner, 0, _rescue(_token(KIND_STANDARD), recipient, 1000), "rescue everything");
        _diffSame(owner, 0, _rescue(_token(KIND_STANDARD), recipient, 0), "rescue zero");
    }

    function test_rescue_moreThanTheBalanceFails() public {
        _fundBoth(KIND_STANDARD, 10);
        Obs memory s = _diffSame(owner, 0, _rescue(_token(KIND_STANDARD), recipient, 11), "rescue more than held");
        assertFalse(s.ok);
        assertEq(s.ret, abi.encodePacked(bytes4(0x90b8ec18)), "TransferFailed()");
    }

    function test_rescue_aStrangerGetsNotOwner() public {
        _fundBoth(KIND_STANDARD, 1000);
        Obs memory s = _diffSame(stranger, 0, _rescue(_token(KIND_STANDARD), stranger, 400), "stranger rescues");
        assertFalse(s.ok);
        assertEq(s.ret, abi.encodePacked(FlashArbExecutor.NotOwner.selector), "NotOwner()");
    }

    function test_rescue_rejectsEther() public {
        _fundBoth(KIND_STANDARD, 1000);
        Obs memory s = _diffSame(owner, 1 wei, _rescue(_token(KIND_STANDARD), recipient, 1), "rescue with ETH");
        assertFalse(s.ok);
        assertEq(s.ret.length, 0);
    }

    function test_rescue_everyKindOfTokenBehavesLikeTheReference() public {
        for (uint256 k; k < TOKEN_KINDS; ++k) {
            _fundBoth(k, 1000);
            _diffSame(
                owner, 0, _rescue(_token(k), recipient, 250), string.concat("rescue, token kind ", vm.toString(k))
            );
        }
    }

    function testFuzz_rescue(uint8 who, uint8 kind, uint8 toPick, uint96 amount, uint96 funded, bytes calldata trailing)
        public
    {
        _fundBoth(kind, funded);
        bytes memory data = bytes.concat(_rescue(_token(kind), _to(toPick), amount), trailing);
        _diffSame(_caller(who), 0, data, "fuzzed rescue");
    }

    function testFuzz_rescueWithAnyTokenAddress(address token, uint8 who, uint96 amount) public {
        vm.assume(token != address(vm) && token != address(this) && token != address(solRef) && token != huff);
        vm.assume(uint160(token) > 0xff || token == address(0)); // precompiles other than the zero address are not tokens
        vm.assume(token != 0x000000000000000000636F6e736F6c652e6c6f67); // forge's console
        _diffSame(_caller(who), 0, _rescue(token, recipient, amount), "rescue with an arbitrary token address");
    }
    // ================================================================== size (information only)

    function test_sizesAreReportedNotClaimed() public view {
        // Not a comparison: milestone 1 implements a subset, so its size says nothing about the finished contract.
        assertGt(huff.code.length, 0);
        assertGt(address(solRef).code.length, 0);
    }
}
