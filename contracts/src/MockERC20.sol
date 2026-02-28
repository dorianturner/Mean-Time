// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable ERC20 for testnet use only.
contract MockERC20 is ERC20 {
    uint8 private _dec;
    address public owner;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _dec = decimals_;
        owner = msg.sender;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        _mint(to, amount);
    }
}
