// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Tokens that misbehave in the ways Solady's safeTransfer and safeApproveWithRetry are built to survive.
///         Every call the executor makes to them is recorded in `trace`, with the executor's own address replaced
///         by a fixed marker (`setSubject`), so the Solidity reference and the Huff build can be compared call by call
///         even though they live at different addresses.
abstract contract ProbeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bytes32 public trace;
    uint256 public calls;
    address public subject;

    function setSubject(address s) external {
        subject = s;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setAllowance(address holder, address spender, uint256 amount) external {
        allowance[holder][spender] = amount;
    }

    function _record(bytes4 selector, address a, uint256 b) internal {
        address caller = msg.sender == subject ? address(0xE) : msg.sender;
        trace = keccak256(abi.encode(trace, selector, caller, a, b));
        ++calls;
    }

    function _move(address to, uint256 amount) internal {
        balanceOf[msg.sender] -= amount; // reverts on underflow, like a normal token
        balanceOf[to] += amount;
    }

    function _approve(address spender, uint256 amount) internal {
        allowance[msg.sender][spender] = amount;
    }
}

/// @dev Returns true.
contract StandardToken is ProbeToken {
    function transfer(address to, uint256 amount) external returns (bool) {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _record(this.approve.selector, spender, amount);
        _approve(spender, amount);
        return true;
    }
}

/// @dev Returns nothing (USDT style).
contract NoReturnToken is ProbeToken {
    function transfer(address to, uint256 amount) external {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
    }

    function approve(address spender, uint256 amount) external {
        _record(this.approve.selector, spender, amount);
        _approve(spender, amount);
    }
}

/// @dev Returns false and changes nothing.
contract FalseToken is ProbeToken {
    function transfer(address to, uint256 amount) external returns (bool) {
        _record(this.transfer.selector, to, amount);
        return false;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _record(this.approve.selector, spender, amount);
        return false;
    }
}

/// @dev Always reverts with a reason.
contract RevertToken is ProbeToken {
    function transfer(address, uint256) external pure {
        revert("nope");
    }

    function approve(address, uint256) external pure {
        revert("nope");
    }
}

/// @dev Returns the number 2: true-looking, but not exactly 1.
contract ReturnTwoToken is ProbeToken {
    function transfer(address to, uint256 amount) external returns (uint256) {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
        return 2;
    }

    function approve(address spender, uint256 amount) external returns (uint256) {
        _record(this.approve.selector, spender, amount);
        _approve(spender, amount);
        return 2;
    }
}

/// @dev Returns 64 bytes, the first word being 1.
contract LongReturnToken is ProbeToken {
    function transfer(address to, uint256 amount) external {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
        assembly {
            mstore(0x00, 1)
            mstore(0x20, 7)
            return(0x00, 0x40)
        }
    }

    function approve(address spender, uint256 amount) external {
        _record(this.approve.selector, spender, amount);
        _approve(spender, amount);
        assembly {
            mstore(0x00, 1)
            mstore(0x20, 7)
            return(0x00, 0x40)
        }
    }
}

/// @dev Returns a single byte, 0x01.
contract ShortReturnToken is ProbeToken {
    function transfer(address to, uint256 amount) external {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
        assembly {
            mstore8(0x00, 1)
            return(0x00, 0x01)
        }
    }

    function approve(address spender, uint256 amount) external {
        _record(this.approve.selector, spender, amount);
        _approve(spender, amount);
        assembly {
            mstore8(0x00, 1)
            return(0x00, 0x01)
        }
    }
}

/// @dev USDT quirk: approving a non-zero amount while a non-zero allowance exists reverts. Returns nothing.
///      This is what makes safeApproveWithRetry reset the allowance to zero and try again.
contract ApproveZeroFirstToken is ProbeToken {
    function transfer(address to, uint256 amount) external {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
    }

    function approve(address spender, uint256 amount) external {
        _record(this.approve.selector, spender, amount);
        require(amount == 0 || allowance[msg.sender][spender] == 0, "reset first");
        _approve(spender, amount);
    }
}

/// @dev The first approve for a holder returns false and changes nothing; afterwards it behaves normally.
contract ApproveFailsOnceToken is ProbeToken {
    mapping(address => bool) public failedOnce;

    function transfer(address to, uint256 amount) external returns (bool) {
        _record(this.transfer.selector, to, amount);
        _move(to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _record(this.approve.selector, spender, amount);
        if (!failedOnce[msg.sender]) {
            failedOnce[msg.sender] = true;
            return false;
        }
        _approve(spender, amount);
        return true;
    }
}

/// @dev Has code but no functions: every call succeeds and returns nothing.
contract BlackHoleToken {
    fallback() external {}
}
