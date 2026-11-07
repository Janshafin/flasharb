// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HuffConfig, HuffNeoConfig} from "foundry-huff-neo/HuffNeoConfig.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

import {FlashArbExecutor} from "../../src/FlashArbExecutor.sol";
import {HuffTestBase} from "./HuffTestBase.sol";
import {
    ProbeToken,
    StandardToken,
    NoReturnToken,
    FalseToken,
    RevertToken,
    ReturnTwoToken,
    LongReturnToken,
    ShortReturnToken,
    ApproveZeroFirstToken,
    ApproveFailsOnceToken,
    BlackHoleToken
} from "../mocks/ProbeTokens.sol";

/// @notice Deploys the Solidity reference executor and the Huff build with the same four addresses, then lets a test run
///         the identical call against both from the same starting state and compare everything that can be observed:
///         whether it succeeded, the exact bytes returned, the ETH balance, and every probe token's balances,
///         allowances and call-by-call trace.
/// @dev The Solidity contract is the reference and is never modified. Each run starts from a snapshot, so the two
///      executors never see each other's effects.
abstract contract DifferentialBase is HuffTestBase {
    using HuffNeoConfig for HuffConfig;

    string internal constant HUFF_FILE = "src/huff/FlashArbExecutor.huff";

    // The four addresses baked into the Huff build as compile-time constants (see the header of FlashArbExecutor.huff).
    address internal owner = makeAddr("owner");
    address internal poolManager = makeAddr("poolManager");
    address internal router = makeAddr("router");
    address internal aqua = makeAddr("aqua");
    address internal stranger = makeAddr("stranger");
    address internal recipient = makeAddr("recipient");

    FlashArbExecutor internal solRef;
    address internal huff;

    /// @dev One instance of each misbehaving token, plus an address with no code at the end.
    address[] internal kinds;
    uint256 internal constant TOKEN_KINDS = 11;
    uint256 internal constant KIND_STANDARD = 0;
    uint256 internal constant KIND_NO_RETURN = 1;
    uint256 internal constant KIND_FALSE = 2;
    uint256 internal constant KIND_REVERT = 3;
    uint256 internal constant KIND_RETURN_TWO = 4;
    uint256 internal constant KIND_LONG_RETURN = 5;
    uint256 internal constant KIND_SHORT_RETURN = 6;
    uint256 internal constant KIND_APPROVE_ZERO_FIRST = 7;
    uint256 internal constant KIND_APPROVE_FAILS_ONCE = 8;
    uint256 internal constant KIND_BLACK_HOLE = 9;
    uint256 internal constant KIND_NO_CODE = 10;

    struct Obs {
        bool ok;
        bytes ret;
        uint256 eth;
        bytes32 tokenState;
    }

    function setUp() public virtual {
        solRef = new FlashArbExecutor(IPoolManager(poolManager), router, aqua, owner);
        huff = _deployHuff(poolManager, router, aqua, owner);

        kinds.push(address(new StandardToken()));
        kinds.push(address(new NoReturnToken()));
        kinds.push(address(new FalseToken()));
        kinds.push(address(new RevertToken()));
        kinds.push(address(new ReturnTwoToken()));
        kinds.push(address(new LongReturnToken()));
        kinds.push(address(new ShortReturnToken()));
        kinds.push(address(new ApproveZeroFirstToken()));
        kinds.push(address(new ApproveFailsOnceToken()));
        kinds.push(address(new BlackHoleToken()));
        kinds.push(makeAddr("token-without-code"));
    }

    /// @dev Compiles src/huff/FlashArbExecutor.huff with the four addresses as compile-time constants and deploys it.
    function _deployHuff(address poolManager_, address router_, address aqua_, address owner_)
        internal
        returns (address)
    {
        return huffConfig()
            .with_constant("POOL_MANAGER_ADDRESS", _hex(poolManager_))
            .with_constant("ROUTER_ADDRESS", _hex(router_))
            .with_constant("AQUA_ADDRESS", _hex(aqua_))
            .with_constant("OWNER_ADDRESS", _hex(owner_))
            .deploy(HUFF_FILE);
    }

    function _hex(address a) internal pure returns (string memory) {
        return HuffNeoConfig.bytes_to_hex_string(abi.encodePacked(a));
    }

    // ------------------------------------------------------------------ choosing inputs

    function _token(uint256 kind) internal view returns (address) {
        return kinds[kind % TOKEN_KINDS];
    }

    function _caller(uint256 who) internal view returns (address) {
        uint256 w = who % 3;
        return w == 0 ? owner : w == 1 ? stranger : address(0xBEEF);
    }

    function _to(uint256 pick) internal view returns (address) {
        uint256 p = pick % 3;
        return p == 0 ? recipient : p == 1 ? stranger : owner;
    }

    function _fundBoth(uint256 kind, uint256 amount) internal {
        address t = _token(kind);
        if (t.code.length == 0) return;
        ProbeToken(t).mint(address(solRef), amount);
        ProbeToken(t).mint(huff, amount);
    }

    function _setAllowanceBoth(uint256 kind, uint256 amount) internal {
        address t = _token(kind);
        if (t.code.length == 0) return;
        ProbeToken(t).setAllowance(address(solRef), aqua, amount);
        ProbeToken(t).setAllowance(huff, aqua, amount);
    }

    // ------------------------------------------------------------------ running and comparing

    function _read(address token, bytes memory call) private view returns (bytes32) {
        (bool ok, bytes memory data) = token.staticcall(call);
        return keccak256(abi.encode(ok, data));
    }

    function _observe(address target, bool ok, bytes memory ret) private view returns (Obs memory o) {
        o.ok = ok;
        o.ret = ret;
        o.eth = target.balance;
        bytes32 h;
        for (uint256 i; i < TOKEN_KINDS - 1; ++i) {
            address t = kinds[i];
            h = keccak256(
                abi.encode(
                    h,
                    _read(t, abi.encodeWithSignature("balanceOf(address)", target)),
                    _read(t, abi.encodeWithSignature("allowance(address,address)", target, aqua)),
                    _read(t, abi.encodeWithSignature("balanceOf(address)", recipient)),
                    _read(t, abi.encodeWithSignature("balanceOf(address)", stranger)),
                    _read(t, abi.encodeWithSignature("balanceOf(address)", owner)),
                    _read(t, abi.encodeWithSignature("trace()")),
                    _read(t, abi.encodeWithSignature("calls()"))
                )
            );
        }
        o.tokenState = h;
    }

    function _run(address target, address caller_, uint256 value, bytes memory data) private returns (Obs memory) {
        for (uint256 i; i < TOKEN_KINDS - 1; ++i) {
            ProbeToken(kinds[i]).setSubject(target); // so token traces can name "the executor" without its address
        }
        vm.deal(caller_, value);
        vm.prank(caller_);
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        return _observe(target, ok, ret);
    }

    /// @dev Runs the same call on the reference and then on the Huff build, each from the same snapshot. Nothing a run
    ///      does is kept: the state is restored afterwards, so the next call starts from the original state again.
    function _diff(address caller_, uint256 value, bytes memory data) internal returns (Obs memory s, Obs memory h) {
        uint256 snap = vm.snapshotState();
        s = _run(address(solRef), caller_, value, data);
        assertTrue(vm.revertToState(snap), "state restored before the Huff run");
        h = _run(huff, caller_, value, data);
        // Restore again, so a test can compare several calls in a row: each one starts from the same state on both sides.
        assertTrue(vm.revertToState(snap), "state restored after the Huff run");
    }

    function _assertSame(Obs memory s, Obs memory h, string memory what) internal pure {
        assertEq(h.ok, s.ok, string.concat(what, ": same success or revert"));
        assertEq(h.ret, s.ret, string.concat(what, ": same bytes returned"));
        assertEq(h.eth, s.eth, string.concat(what, ": same ETH balance"));
        assertEq(h.tokenState, s.tokenState, string.concat(what, ": same token balances, allowances and call traces"));
    }

    /// @dev For malformed calldata the approved scope is "both revert"; this checks that and nothing about the bytes.
    function _assertSameOutcome(Obs memory s, Obs memory h, string memory what) internal pure {
        assertEq(h.ok, s.ok, string.concat(what, ": same success or revert"));
        if (s.ok) _assertSame(s, h, what);
    }

    function _diffSame(address caller_, uint256 value, bytes memory data, string memory what)
        internal
        returns (Obs memory s)
    {
        Obs memory h;
        (s, h) = _diff(caller_, value, data);
        _assertSame(s, h, what);
    }
}
