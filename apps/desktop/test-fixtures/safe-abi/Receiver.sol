// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test-only receiver: the Solidity ABI decoder independently validates frontend calldata.
contract Receiver {
    struct Owner { address account; bool enabled; string label; }
    struct Payload {
        uint256 amount;
        int128 delta;
        bool active;
        address recipient;
        bytes32 tag;
        string memo;
        bytes data;
        uint256[] ids;
        bytes[] blobs;
        Owner[] owners;
        int256[2] limits;
        string[2] labels;
    }
    bytes32 public lastHash;
    address public lastSender;
    uint256 public lastValue;
    uint256 public calls;
    function record(Payload calldata payload) external payable { _record(payload); }
    function recordNoValue(Payload calldata payload) external { _record(payload); }
    function _record(Payload calldata payload) internal {
        lastHash = keccak256(abi.encode(payload));
        lastSender = msg.sender;
        lastValue = msg.value;
        calls++;
    }
}
