// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {Test} from "forge-std/Test.sol";
import {MeanTime} from "../src/MeanTime.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MeanTimeTest is Test {
    MeanTime public meantime;
    MockERC20 public usdc; // inbound token (what arrives from CCTP)
    MockERC20 public eurc; // payment token (what the relayer pays)

    address public bridge = makeAddr("bridge");
    address public alice = makeAddr("alice"); // original receiver
    address public relayer = makeAddr("relayer");

    bytes32 constant MSG_HASH = keccak256("cctp-message-1");
    uint256 constant USDC_AMOUNT = 1000e6; // 1000 USDC
    uint256 constant EURC_PRICE = 995e6; // 995 EURC (0.5% discount)

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC");
        eurc = new MockERC20("Euro Coin", "EURC");
        meantime = new MeanTime(bridge);

        // Fund the relayer with EURC for fills
        eurc.mint(relayer, EURC_PRICE * 10);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _mint() internal returns (uint256 tokenId) {
        // Simulate bridge: pre-fund contract with inbound USDC, then mint the NFT
        usdc.mint(address(meantime), USDC_AMOUNT);
        vm.prank(bridge);
        tokenId = meantime.mint(MSG_HASH, address(usdc), USDC_AMOUNT, alice);
    }

    function _mintAndList() internal returns (uint256 tokenId) {
        tokenId = _mint();
        vm.prank(alice);
        meantime.list(tokenId, EURC_PRICE, address(eurc));
    }

    function _mintListAndFill() internal returns (uint256 tokenId) {
        tokenId = _mintAndList();
        vm.startPrank(relayer);
        eurc.approve(address(meantime), EURC_PRICE);
        meantime.fill(tokenId);
        vm.stopPrank();
    }

    // ── mint() ─────────────────────────────────────────────────────────────────

    function test_MintSetsState() public {
        uint256 tokenId = _mint();

        // NFT is owned by the contract itself, not alice
        assertEq(meantime.ownerOf(tokenId), address(meantime));
        // economic ownership is alice's
        assertEq(meantime.beneficialOwner(tokenId), alice);
        // message hash maps to this token
        assertEq(meantime.tokenByMessageHash(MSG_HASH), tokenId);

        (bytes32 hash, address token, uint256 amount, uint256 mintedAt) = meantime.nftData(tokenId);
        assertEq(hash, MSG_HASH);
        assertEq(token, address(usdc));
        assertEq(amount, USDC_AMOUNT);
        assertEq(mintedAt, block.timestamp);
    }

    function test_MintTokenIdsIncrement() public {
        usdc.mint(address(meantime), USDC_AMOUNT * 2);
        vm.prank(bridge);
        uint256 id1 = meantime.mint(keccak256("hash-a"), address(usdc), USDC_AMOUNT, alice);
        vm.prank(bridge);
        uint256 id2 = meantime.mint(keccak256("hash-b"), address(usdc), USDC_AMOUNT, alice);
        assertEq(id2, id1 + 1);
    }

    function test_MintEmitsEvent() public {
        usdc.mint(address(meantime), USDC_AMOUNT);
        vm.expectEmit(true, true, false, true);
        emit MeanTime.Minted(1, alice, address(usdc), USDC_AMOUNT, MSG_HASH);
        vm.prank(bridge);
        meantime.mint(MSG_HASH, address(usdc), USDC_AMOUNT, alice);
    }

    function test_MintRevertsIfNotBridge() public {
        vm.prank(alice);
        vm.expectRevert(MeanTime.NotBridge.selector);
        meantime.mint(MSG_HASH, address(usdc), USDC_AMOUNT, alice);
    }

    function test_MintRevertsOnDuplicateMessageHash() public {
        _mint();
        vm.prank(bridge);
        vm.expectRevert(MeanTime.AlreadyMinted.selector);
        meantime.mint(MSG_HASH, address(usdc), USDC_AMOUNT, alice);
    }

    // ── list() ─────────────────────────────────────────────────────────────────

    function test_ListSetsListing() public {
        uint256 tokenId = _mint();
        vm.prank(alice);
        meantime.list(tokenId, EURC_PRICE, address(eurc));

        (uint256 price, address token, bool active) = meantime.listings(tokenId);
        assertEq(price, EURC_PRICE);
        assertEq(token, address(eurc));
        assertTrue(active);
    }

    function test_ListEmitsEvent() public {
        uint256 tokenId = _mint();
        vm.expectEmit(true, false, false, true);
        emit MeanTime.Listed(tokenId, EURC_PRICE, address(eurc), block.timestamp);
        vm.prank(alice);
        meantime.list(tokenId, EURC_PRICE, address(eurc));
    }

    function test_ListRevertsIfNotBeneficialOwner() public {
        uint256 tokenId = _mint();
        vm.prank(relayer);
        vm.expectRevert(MeanTime.NotBeneficialOwner.selector);
        meantime.list(tokenId, EURC_PRICE, address(eurc));
    }

    function test_ListRevertsIfAlreadyListed() public {
        uint256 tokenId = _mintAndList();
        vm.prank(alice);
        vm.expectRevert(MeanTime.AlreadyListed.selector);
        meantime.list(tokenId, EURC_PRICE, address(eurc));
    }

    function test_ListRevertsOnZeroPrice() public {
        uint256 tokenId = _mint();
        vm.prank(alice);
        vm.expectRevert(MeanTime.InvalidPrice.selector);
        meantime.list(tokenId, 0, address(eurc));
    }

    // ── delist() ───────────────────────────────────────────────────────────────

    function test_DelistClearsListing() public {
        uint256 tokenId = _mintAndList();
        vm.prank(alice);
        meantime.delist(tokenId);

        (,, bool active) = meantime.listings(tokenId);
        assertFalse(active);
        // beneficial ownership is unchanged
        assertEq(meantime.beneficialOwner(tokenId), alice);
    }

    function test_DelistEmitsEvent() public {
        uint256 tokenId = _mintAndList();
        vm.expectEmit(true, false, false, false);
        emit MeanTime.Delisted(tokenId);
        vm.prank(alice);
        meantime.delist(tokenId);
    }

    function test_DelistRevertsIfNotBeneficialOwner() public {
        uint256 tokenId = _mintAndList();
        vm.prank(relayer);
        vm.expectRevert(MeanTime.NotBeneficialOwner.selector);
        meantime.delist(tokenId);
    }

    function test_DelistRevertsIfNotListed() public {
        uint256 tokenId = _mint();
        vm.prank(alice);
        vm.expectRevert(MeanTime.NotListed.selector);
        meantime.delist(tokenId);
    }

    function test_DelistAndRelistChangesPrice() public {
        uint256 tokenId = _mintAndList();
        vm.startPrank(alice);
        meantime.delist(tokenId);
        meantime.list(tokenId, EURC_PRICE / 2, address(eurc)); // renegotiated price
        vm.stopPrank();

        (uint256 price,, bool active) = meantime.listings(tokenId);
        assertEq(price, EURC_PRICE / 2);
        assertTrue(active);
    }

    // ── fill() ─────────────────────────────────────────────────────────────────

    function test_FillUpdatesBeneficialOwnerAndPaysSellerr() public {
        uint256 tokenId = _mintAndList();

        vm.startPrank(relayer);
        eurc.approve(address(meantime), EURC_PRICE);
        meantime.fill(tokenId);
        vm.stopPrank();

        // relayer is the new beneficial owner
        assertEq(meantime.beneficialOwner(tokenId), relayer);
        // alice received the payment
        assertEq(eurc.balanceOf(alice), EURC_PRICE);
        // listing was cleared
        (,, bool active) = meantime.listings(tokenId);
        assertFalse(active);
        // NFT still lives in the contract
        assertEq(meantime.ownerOf(tokenId), address(meantime));
    }

    function test_FillEmitsEvent() public {
        uint256 tokenId = _mintAndList();
        vm.startPrank(relayer);
        eurc.approve(address(meantime), EURC_PRICE);
        vm.expectEmit(true, true, true, true);
        emit MeanTime.Filled(tokenId, relayer, alice, address(eurc), EURC_PRICE, 0);
        meantime.fill(tokenId);
        vm.stopPrank();
    }

    function test_FillRevertsIfNotListed() public {
        uint256 tokenId = _mint();
        vm.prank(relayer);
        vm.expectRevert(MeanTime.NotListed.selector);
        meantime.fill(tokenId);
    }

    // ── settle() ───────────────────────────────────────────────────────────────

    function test_SettleToOriginalRecipient() public {
        uint256 tokenId = _mint();
        uint256 aliceBefore = usdc.balanceOf(alice);

        meantime.settle(MSG_HASH);

        assertEq(usdc.balanceOf(alice) - aliceBefore, USDC_AMOUNT);
        // all state cleared
        assertEq(meantime.tokenByMessageHash(MSG_HASH), 0);
        assertEq(meantime.beneficialOwner(tokenId), address(0));
        vm.expectRevert(); // NFT burned
        meantime.ownerOf(tokenId);
    }

    function test_SettleToRelayerAfterFill() public {
        uint256 tokenId = _mintListAndFill();
        uint256 relayerUsdcBefore = usdc.balanceOf(relayer);

        meantime.settle(MSG_HASH);

        // relayer receives the inbound USDC
        assertEq(usdc.balanceOf(relayer) - relayerUsdcBefore, USDC_AMOUNT);
        // alice kept the EURC spread
        assertEq(eurc.balanceOf(alice), EURC_PRICE);
        // token fully cleaned up
        vm.expectRevert();
        meantime.ownerOf(tokenId);
    }

    function test_SettleEmitsEvent() public {
        uint256 tokenId = _mint();
        vm.expectEmit(true, true, false, true);
        emit MeanTime.Settled(tokenId, alice, address(usdc), USDC_AMOUNT);
        meantime.settle(MSG_HASH);
    }

    function test_SettleRevertsForUnknownHash() public {
        vm.expectRevert(MeanTime.UnknownTransfer.selector);
        meantime.settle(keccak256("nonexistent"));
    }

    function test_SettleRevertsOnDoubleSettle() public {
        _mint();
        meantime.settle(MSG_HASH);
        vm.expectRevert(MeanTime.UnknownTransfer.selector);
        meantime.settle(MSG_HASH);
    }

    // ── Edge cases (from spec) ─────────────────────────────────────────────────

    // Attestation arrives while NFT is listed but unfilled.
    // The seller (beneficialOwner) receives the inbound token. Listing is cleaned up.
    function test_EdgeCase_SettleWhileListed() public {
        uint256 tokenId = _mintAndList();

        (,, bool activeBefore) = meantime.listings(tokenId);
        assertTrue(activeBefore);

        meantime.settle(MSG_HASH);

        // alice was beneficial owner at settle time
        assertEq(usdc.balanceOf(alice), USDC_AMOUNT);
        // listing was cleared by settle
        (,, bool activeAfter) = meantime.listings(tokenId);
        assertFalse(activeAfter);
    }

    // If settle() lands before fill(): fill() reverts because the listing was deleted.
    function test_EdgeCase_FillRevertsAfterSettle() public {
        uint256 tokenId = _mintAndList();
        meantime.settle(MSG_HASH);

        vm.startPrank(relayer);
        eurc.approve(address(meantime), EURC_PRICE);
        vm.expectRevert(MeanTime.NotListed.selector);
        meantime.fill(tokenId);
        vm.stopPrank();
    }

    // If fill() lands before settle(): settle pays the relayer. Both parties get what they expected.
    function test_EdgeCase_FillThenSettle() public {
        _mintListAndFill();
        meantime.settle(MSG_HASH);

        // relayer received USDC, alice received EURC
        assertEq(usdc.balanceOf(relayer), USDC_AMOUNT);
        assertEq(eurc.balanceOf(alice), EURC_PRICE);
    }

    // If delist() lands before fill(): fill() reverts cleanly, no funds moved.
    function test_EdgeCase_DelistBeforeFill() public {
        uint256 tokenId = _mintAndList();

        vm.prank(alice);
        meantime.delist(tokenId);

        vm.startPrank(relayer);
        eurc.approve(address(meantime), EURC_PRICE);
        vm.expectRevert(MeanTime.NotListed.selector);
        meantime.fill(tokenId);
        vm.stopPrank();

        // relayer's EURC is untouched
        assertEq(eurc.balanceOf(relayer), EURC_PRICE * 10);
    }

    // If fill() lands before delist(): delist reverts. Relayer's fill completed.
    function test_EdgeCase_FillBeforeDelist() public {
        uint256 tokenId = _mintListAndFill();

        vm.prank(alice);
        vm.expectRevert(MeanTime.NotBeneficialOwner.selector); // alice is no longer beneficial owner
        meantime.delist(tokenId);
    }

    // Relayer fills then relists into secondary market — fully supported by existing functions.
    function test_RelayerRelists_SecondaryBuyerSettles() public {
        address secondaryBuyer = makeAddr("secondaryBuyer");
        eurc.mint(secondaryBuyer, EURC_PRICE);

        uint256 tokenId = _mintListAndFill();

        // relayer relists at same price (e.g. immediately flips)
        vm.prank(relayer);
        meantime.list(tokenId, EURC_PRICE, address(eurc));

        // secondary buyer fills
        vm.startPrank(secondaryBuyer);
        eurc.approve(address(meantime), EURC_PRICE);
        meantime.fill(tokenId);
        vm.stopPrank();

        assertEq(meantime.beneficialOwner(tokenId), secondaryBuyer);

        // attestation arrives — secondary buyer receives USDC
        uint256 buyerBefore = usdc.balanceOf(secondaryBuyer);
        meantime.settle(MSG_HASH);
        assertEq(usdc.balanceOf(secondaryBuyer) - buyerBefore, USDC_AMOUNT);
    }

    // ── Fuzz tests ─────────────────────────────────────────────────────────────

    // Multiple independent transfers settle to the correct recipients.
    function testFuzz_IndependentTransfersSettleCorrectly(uint96 amount1, uint96 amount2) public {
        vm.assume(amount1 > 0 && amount2 > 0);

        address bob = makeAddr("bob");
        bytes32 hash1 = keccak256("hash-1");
        bytes32 hash2 = keccak256("hash-2");

        usdc.mint(address(meantime), uint256(amount1) + uint256(amount2));

        vm.prank(bridge);
        meantime.mint(hash1, address(usdc), amount1, alice);
        vm.prank(bridge);
        meantime.mint(hash2, address(usdc), amount2, bob);

        meantime.settle(hash1);
        meantime.settle(hash2);

        assertEq(usdc.balanceOf(alice), amount1);
        assertEq(usdc.balanceOf(bob), amount2);
    }

    // Any reserve price within relayer's balance is fillable.
    function testFuzz_FillAtAnyPrice(uint96 price) public {
        vm.assume(price > 0);

        eurc.mint(relayer, price);

        uint256 tokenId = _mint();
        vm.prank(alice);
        meantime.list(tokenId, price, address(eurc));

        vm.startPrank(relayer);
        eurc.approve(address(meantime), price);
        meantime.fill(tokenId);
        vm.stopPrank();

        assertEq(meantime.beneficialOwner(tokenId), relayer);
        assertEq(eurc.balanceOf(alice), price);
    }

    // ── getReceivable() ────────────────────────────────────────────────────────

    function test_GetReceivable_Unlisted() public {
        uint256 tokenId = _mint();

        (address owner, MeanTime.NFTData memory data, MeanTime.Listing memory listing, uint256 age, uint256 secsLeft) =
            meantime.getReceivable(tokenId);

        assertEq(owner, alice);
        assertEq(data.inboundAmount, USDC_AMOUNT);
        assertEq(data.inboundToken, address(usdc));
        assertEq(data.cctpMessageHash, MSG_HASH);
        assertFalse(listing.active);
        assertEq(age, 0); // no time has passed
        assertEq(secsLeft, 1020); // full window remaining
    }

    function test_GetReceivable_Listed() public {
        uint256 tokenId = _mintAndList();

        (,, MeanTime.Listing memory listing,,) = meantime.getReceivable(tokenId);

        assertTrue(listing.active);
        assertEq(listing.reservePrice, EURC_PRICE);
        assertEq(listing.paymentToken, address(eurc));
    }

    function test_GetReceivable_TimeProgresses() public {
        uint256 tokenId = _mint();
        vm.warp(block.timestamp + 600); // 10 minutes later

        (,,, uint256 age, uint256 secsLeft) = meantime.getReceivable(tokenId);

        assertEq(age, 600);
        assertEq(secsLeft, 420); // 1020 - 600
    }

    function test_GetReceivable_PastEstimate() public {
        uint256 tokenId = _mint();
        vm.warp(block.timestamp + 2000); // well past 1020s

        (,,, uint256 age, uint256 secsLeft) = meantime.getReceivable(tokenId);

        assertEq(age, 2000);
        assertEq(secsLeft, 0); // clamped to 0
    }

    function test_GetReceivable_BurnedToken() public {
        uint256 tokenId = _mint();
        meantime.settle(MSG_HASH);

        (address owner, MeanTime.NFTData memory data,, uint256 age, uint256 secsLeft) = meantime.getReceivable(tokenId);

        assertEq(owner, address(0));
        assertEq(data.mintedAt, 0);
        assertEq(age, 0);
        assertEq(secsLeft, 0);
    }

    // ── estimatedSettleTime() ──────────────────────────────────────────────────

    function test_EstimatedSettleTime() public {
        uint256 tokenId = _mint();
        uint256 expected = block.timestamp + 1020;
        assertEq(meantime.estimatedSettleTime(tokenId), expected);
    }

    function test_EstimatedSettleTime_BurnedIsZero() public {
        uint256 tokenId = _mint();
        meantime.settle(MSG_HASH);
        assertEq(meantime.estimatedSettleTime(tokenId), 0);
    }

    // ── tokenURI() ─────────────────────────────────────────────────────────────

    function test_TokenURI_ReturnsDataURI() public {
        uint256 tokenId = _mint();
        string memory uri = meantime.tokenURI(tokenId);

        // Must start with the data URI scheme
        assertTrue(bytes(uri).length > 0);
        // Check it starts with "data:application/json;base64,"
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory uriBytes = bytes(uri);
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(uriBytes[i], prefix[i]);
        }
    }

    function test_TokenURI_BurnedReturnsEmpty() public {
        uint256 tokenId = _mint();
        meantime.settle(MSG_HASH);
        string memory uri = meantime.tokenURI(tokenId);
        assertEq(bytes(uri).length, 0);
    }

    function test_TokenURI_ListedShowsPrice() public {
        uint256 tokenId = _mintAndList();
        string memory uri = meantime.tokenURI(tokenId);
        // Just ensure it returns a non-empty data URI (listing data embedded in SVG)
        assertTrue(bytes(uri).length > 0);
    }

    function test_TokenURI_ProgressChangesWithTime() public {
        uint256 tokenId = _mint();
        string memory uriBefore = meantime.tokenURI(tokenId);

        vm.warp(block.timestamp + 510); // half way
        string memory uriAfter = meantime.tokenURI(tokenId);

        // URIs should differ because age/remaining/progress changed
        assertTrue(keccak256(bytes(uriBefore)) != keccak256(bytes(uriAfter)));
    }
}
