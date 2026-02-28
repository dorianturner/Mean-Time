pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Hello.sol";

contract DeployHello is Script {
    function run() external {
        // Load the private key from your .env file
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Start broadcasting transactions to the network
        vm.startBroadcast(deployerPrivateKey);

        // Deploy the contract with an initial message
        new HelloArc("FastCCTP is coming...");

        vm.stopBroadcast();
    }
}