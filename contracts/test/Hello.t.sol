// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {HelloArc} from "../src/Hello.sol";

contract HelloArcTest is Test {
    HelloArc public hello;

    function setUp() public {
        hello = new HelloArc("FastCCTP is coming...");
    }

    function test_InitialMessage() public view {
        assertEq(hello.message(), "FastCCTP is coming...");
    }

    function test_UpdateMessage() public {
        hello.updateMessage("InstantSettle is live.");
        assertEq(hello.message(), "InstantSettle is live.");
    }
}
