// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HuffConfig, HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";

import {FlashArbExecutor} from "../src/FlashArbExecutor.sol";
import {DifferentialBase} from "./base/DifferentialBase.sol";

/// @notice Milestone 1: approveAqua and malformed calldata on the Huff executor, compared against the Solidity reference.
/// @dev Split out of ExecutorShell.t.sol to keep each file reviewable. It does not touch the PoolManager.
contract ExecutorApproveAquaTest is DifferentialBase {
    using HuffNeoConfig for HuffConfig;

    // ================================================================== approveAqua

    function _tokens(uint8[] memory ks) internal view returns (address[] memory t) {
        t = new address[](ks.length);
        for (uint256 i; i < ks.length; ++i) {
            t[i] = _token(ks[i]);
        }
    }

    function _approve(address[] memory tokens) internal pure returns (bytes memory) {
        return abi.encodeCall(FlashArbExecutor.approveAqua, (tokens));
    }

    function test_approveAqua_emptyArrayDoesNothing() public {
        Obs memory s = _diffSame(owner, 0, _approve(new address[](0)), "approve nothing");
        assertTrue(s.ok);
    }

    /// @dev "Identical" proves nothing if both executors quietly do nothing, so check the effect itself: after
    ///      approveAqua, each executor has given Aqua the maximum allowance on every token.
    function test_approveAqua_bothExecutorsReallySetTheMaximumAllowance() public {
        address[] memory t = new address[](3);
        t[0] = _token(KIND_STANDARD);
        t[1] = _token(KIND_NO_RETURN);
        t[2] = _token(KIND_LONG_RETURN);
        address[2] memory executors = [address(solRef), huff];
        for (uint256 e; e < executors.length; ++e) {
            uint256 snap = vm.snapshotState();
            vm.prank(owner);
            (bool ok,) = executors[e].call(_approve(t));
            assertTrue(ok, "approveAqua succeeds");
            for (uint256 i; i < t.length; ++i) {
                (, bytes memory ret) =
                    t[i].staticcall(abi.encodeWithSignature("allowance(address,address)", executors[e], aqua));
                assertEq(abi.decode(ret, (uint256)), type(uint256).max, "allowance is the maximum");
            }
            vm.revertToState(snap);
        }
        // And the two are indistinguishable from outside.
        _diffSame(owner, 0, _approve(t), "approve three tokens");
    }

    function test_approveAqua_aStrangerGetsNotOwner() public {
        address[] memory t = new address[](1);
        t[0] = _token(KIND_STANDARD);
        Obs memory s = _diffSame(stranger, 0, _approve(t), "stranger approves");
        assertFalse(s.ok);
        assertEq(s.ret, abi.encodePacked(FlashArbExecutor.NotOwner.selector));
    }

    function test_approveAqua_theRetryResetsTheAllowanceThenApprovesAgain() public {
        _setAllowanceBoth(KIND_APPROVE_ZERO_FIRST, 5); // a non-zero allowance makes the first approve revert
        address[] memory t = new address[](1);
        t[0] = _token(KIND_APPROVE_ZERO_FIRST);
        Obs memory s = _diffSame(owner, 0, _approve(t), "approve a token that needs a reset first");
        assertTrue(s.ok, "it works after the reset");
    }

    function test_approveAqua_aFalseOnTheFirstTryIsRetried() public {
        address[] memory t = new address[](1);
        t[0] = _token(KIND_APPROVE_FAILS_ONCE);
        Obs memory s = _diffSame(owner, 0, _approve(t), "approve a token that fails once");
        assertTrue(s.ok);
    }

    function test_approveAqua_aTokenThatAlwaysFailsGivesApproveFailed() public {
        address[] memory t = new address[](1);
        t[0] = _token(KIND_FALSE);
        Obs memory s = _diffSame(owner, 0, _approve(t), "approve a token that always returns false");
        assertFalse(s.ok);
        assertEq(s.ret, abi.encodePacked(bytes4(0x3e3f8f73)), "ApproveFailed()");
    }

    function test_approveAqua_oneBadTokenUndoesTheWholeBatch() public {
        address[] memory t = new address[](3);
        t[0] = _token(KIND_STANDARD);
        t[1] = _token(KIND_REVERT);
        t[2] = _token(KIND_NO_RETURN);
        Obs memory s = _diffSame(owner, 0, _approve(t), "approve a batch with a reverting token");
        assertFalse(s.ok);
        assertEq(s.ret, abi.encodePacked(bytes4(0x3e3f8f73)), "ApproveFailed()");
    }

    function test_approveAqua_aTokenWithoutCodeFails() public {
        address[] memory t = new address[](1);
        t[0] = _token(KIND_NO_CODE);
        Obs memory s = _diffSame(owner, 0, _approve(t), "approve an address with no code");
        assertFalse(s.ok);
    }

    function test_approveAqua_duplicatesAreFine() public {
        address[] memory t = new address[](3);
        t[0] = _token(KIND_STANDARD);
        t[1] = _token(KIND_STANDARD);
        t[2] = _token(KIND_STANDARD);
        _diffSame(owner, 0, _approve(t), "approve the same token three times");
    }

    function test_approveAqua_everyKindOfTokenAloneBehavesLikeTheReference() public {
        for (uint256 k; k < TOKEN_KINDS; ++k) {
            address[] memory t = new address[](1);
            t[0] = _token(k);
            _diffSame(owner, 0, _approve(t), string.concat("approve, token kind ", vm.toString(k)));
        }
    }

    function testFuzz_approveAqua(uint8 who, uint8[] calldata ks, uint16 presetMask, bytes calldata trailing) public {
        vm.assume(ks.length <= 8);
        for (uint256 k; k < TOKEN_KINDS; ++k) {
            if (presetMask & (1 << k) != 0) _setAllowanceBoth(k, 5);
        }
        bytes memory data = bytes.concat(_approve(_tokens(ks)), trailing);
        _diffSame(_caller(who), 0, data, "fuzzed approveAqua");
    }

    // ================================================================== malformed calldata (approved scope: both revert)

    function _sel(bytes4 s, bytes memory args) internal pure returns (bytes memory) {
        return bytes.concat(s, args);
    }

    function test_malformed_rescue() public {
        _fundBoth(KIND_STANDARD, 1000);
        address t = _token(KIND_STANDARD);
        bytes4 sel = FlashArbExecutor.rescue.selector;
        bytes memory good = abi.encode(t, recipient, uint256(5));
        // truncated by one byte, and by a whole word
        _assertCase(owner, _sel(sel, _cut(good, 95)), "rescue: one byte short");
        _assertCase(owner, _sel(sel, _cut(good, 64)), "rescue: one word short");
        _assertCase(owner, sel == bytes4(0) ? good : _sel(sel, ""), "rescue: no arguments");
        // dirty high bits in either address argument
        _assertCase(
            owner,
            _sel(sel, abi.encode(bytes32(uint256(uint160(t)) | (1 << 200)), recipient, uint256(5))),
            "rescue: dirty token"
        );
        _assertCase(
            owner,
            _sel(sel, abi.encode(t, bytes32(uint256(uint160(recipient)) | (1 << 255)), uint256(5))),
            "rescue: dirty recipient"
        );
        // the decoder runs before the owner check, so a stranger with bad input still just reverts
        _assertCase(stranger, _sel(sel, _cut(good, 95)), "rescue: stranger, one byte short");
    }

    function test_malformed_approveAqua() public {
        bytes4 sel = FlashArbExecutor.approveAqua.selector;
        address a = _token(KIND_STANDARD);
        _assertCase(owner, _sel(sel, ""), "approveAqua: no arguments");
        _assertCase(owner, _sel(sel, hex"00"), "approveAqua: one byte");
        _assertCase(owner, _sel(sel, abi.encode(uint256(0x20))), "approveAqua: offset but no length");
        _assertCase(owner, _sel(sel, abi.encode(type(uint256).max)), "approveAqua: offset is huge");
        _assertCase(owner, _sel(sel, abi.encode(uint256(0x20), type(uint256).max)), "approveAqua: length is huge");
        _assertCase(owner, _sel(sel, abi.encode(uint256(0x20), uint256(1))), "approveAqua: length 1 but no element");
        _assertCase(owner, _sel(sel, abi.encode(uint256(0x20), uint256(2), a)), "approveAqua: length 2 but one element");
        _assertCase(owner, _sel(sel, abi.encode(uint256(0x40), uint256(0))), "approveAqua: offset past the length word");
        _assertCase(
            owner,
            _sel(sel, abi.encode(uint256(0x20), uint256(1), bytes32(uint256(uint160(a)) | (1 << 170)))),
            "approveAqua: dirty element"
        );
        _assertCase(
            stranger, _sel(sel, abi.encode(uint256(0x20), uint256(1))), "approveAqua: stranger, length 1 but no element"
        );
        // an offset that points at a valid array somewhere else in the calldata is accepted by both
        _assertCase(
            owner,
            _sel(sel, abi.encode(uint256(0x60), uint256(0xdead), uint256(0xbeef), uint256(1), a)),
            "approveAqua: offset skips filler"
        );
    }

    function testFuzz_malformedRescueArguments(bytes calldata args, uint8 who) public {
        vm.assume(args.length <= 160);
        _fundBoth(KIND_STANDARD, 1000);
        _assertCase(_caller(who), _sel(FlashArbExecutor.rescue.selector, args), "rescue with random argument bytes");
    }

    function testFuzz_malformedApproveArguments(bytes calldata args, uint8 who) public {
        vm.assume(args.length <= 320);
        _assertCase(
            _caller(who), _sel(FlashArbExecutor.approveAqua.selector, args), "approveAqua with random argument bytes"
        );
    }

    /// @dev The approved scope for malformed calldata is that both revert (or both succeed identically). Return data is
    ///      compared as well here; if the two ever differ only in bytes, the test says so instead of hiding it.
    function _assertCase(address caller_, bytes memory data, string memory what) internal {
        (Obs memory s, Obs memory h) = _diff(caller_, 0, data);
        _assertSameOutcome(s, h, what);
        assertEq(h.ret, s.ret, string.concat(what, ": same revert bytes (stricter than the approved scope)"));
    }

    function _cut(bytes memory b, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = b[i];
        }
    }
}
