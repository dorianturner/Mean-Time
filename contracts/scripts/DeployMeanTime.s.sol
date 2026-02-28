// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Script, console} from "forge-std/Script.sol";
import {MeanTime} from "../src/MeanTime.sol";
import {MockERC20} from "../src/MockERC20.sol";

contract DeployMeanTime is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);

        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 eurc = new MockERC20("Euro Coin", "EURC", 6);

        // For MVP the deployer acts as bridge (calls mint + settle).
        // In production replace with the CCTP MessageTransmitter address on Arc.
        MeanTime meantime = new MeanTime(deployer);

        // Give the deployer a float for testing (USDC + EURC).
        usdc.mint(deployer, 1_000_000 * 1e6);
        eurc.mint(deployer, 1_000_000 * 1e6);

        vm.stopBroadcast();

        console.log("=== Deployed ===");
        console.log("USDC:     ", address(usdc));
        console.log("EURC:     ", address(eurc));
        console.log("MeanTime: ", address(meantime));
        console.log("Bridge:   ", deployer);

        // Write addresses for backend + frontend to consume.
        string memory json = string.concat(
            '{"usdc":"',
            vm.toString(address(usdc)),
            '","eurc":"',
            vm.toString(address(eurc)),
            '","meantime":"',
            vm.toString(address(meantime)),
            '","bridge":"',
            vm.toString(deployer),
            '"}'
        );
        vm.writeFile("deployments.json", json);
        console.log("Addresses written to deployments.json");
    }
}
