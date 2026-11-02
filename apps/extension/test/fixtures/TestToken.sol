// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract TestToken {
    string public name = "FnzSafe Local Token";
    string public symbol = "FTEST";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    constructor(address owner) { balanceOf[owner] = 1000000000; }
    function transfer(address to, uint256 value) public returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
