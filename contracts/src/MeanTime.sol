// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MeanTime — Tokenised CCTP receivables
/// @notice Every CCTP inbound transfer is represented as an NFT held by this contract.
///         Economic ownership is tracked via beneficialOwner. The NFT never leaves the contract.
contract MeanTime is ERC721 {
    // ── Storage ────────────────────────────────────────────────────────────────

    /// @notice The authorised bridge address — the only address that can call mint().
    address public bridge;

    /// @dev Start at 1 so that tokenId 0 is a reliable sentinel for "not found"
    ///      in the tokenByMessageHash mapping.
    uint256 private _nextTokenId = 1;

    struct NFTData {
        bytes32 cctpMessageHash; // links this NFT to a specific CCTP transfer
        address inboundToken;    // the token that will arrive at attestation (e.g. USDC, EURC)
        uint256 inboundAmount;   // face value, in units of inboundToken
        uint256 mintedAt;        // block.timestamp at mint — proxy for attestation progress
    }

    struct Listing {
        uint256 reservePrice; // minimum amount seller will accept, in units of paymentToken
        address paymentToken; // any ERC20 the seller wants in return
        bool active;
    }

    mapping(uint256 tokenId => NFTData) public nftData;
    mapping(uint256 tokenId => Listing) public listings;
    mapping(uint256 tokenId => address) public beneficialOwner;
    mapping(bytes32 messageHash => uint256 tokenId) public tokenByMessageHash;

    // ── Events ─────────────────────────────────────────────────────────────────

    event Minted(
        uint256 indexed tokenId,
        address indexed recipient,
        address inboundToken,
        uint256 inboundAmount,
        bytes32 cctpMessageHash
    );
    event Listed(uint256 indexed tokenId, uint256 reservePrice, address paymentToken, uint256 listedAt);
    event Delisted(uint256 indexed tokenId);
    event Filled(
        uint256 indexed tokenId,
        address indexed relayer,
        address indexed seller,
        address paymentToken,
        uint256 amount
    );
    event Settled(uint256 indexed tokenId, address indexed recipient, address inboundToken, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _bridge) ERC721("MeanTime Receivable", "MTR") {
        bridge = _bridge;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyBridge() {
        require(msg.sender == bridge, "not bridge");
        _;
    }

    // ── Core functions ─────────────────────────────────────────────────────────

    /// @notice Called by the bridge when a CCTP burn is detected on the source chain.
    ///         Mints an NFT representing the incoming receivable to address(this).
    ///         The beneficial owner (recipient of inboundToken at settlement) is set to `recipient`.
    function mint(bytes32 cctpMessageHash, address inboundToken, uint256 inboundAmount, address recipient)
        external
        onlyBridge
        returns (uint256 tokenId)
    {
        require(tokenByMessageHash[cctpMessageHash] == 0, "already minted");
        require(inboundToken != address(0), "invalid token");
        require(inboundAmount > 0, "invalid amount");
        require(recipient != address(0), "invalid recipient");

        tokenId = _nextTokenId++;
        _mint(address(this), tokenId);

        nftData[tokenId] =
            NFTData({cctpMessageHash: cctpMessageHash, inboundToken: inboundToken, inboundAmount: inboundAmount, mintedAt: block.timestamp});

        beneficialOwner[tokenId] = recipient;
        tokenByMessageHash[cctpMessageHash] = tokenId;

        emit Minted(tokenId, recipient, inboundToken, inboundAmount, cctpMessageHash);
    }

    /// @notice List the receivable NFT for sale. The seller specifies the minimum price
    ///         and which token they want to receive. The NFT stays in the contract.
    function list(uint256 tokenId, uint256 reservePrice, address paymentToken) external {
        require(beneficialOwner[tokenId] == msg.sender, "not beneficial owner");
        require(!listings[tokenId].active, "already listed");
        require(reservePrice > 0, "invalid price");
        require(paymentToken != address(0), "invalid token");

        listings[tokenId] = Listing({reservePrice: reservePrice, paymentToken: paymentToken, active: true});

        emit Listed(tokenId, reservePrice, paymentToken, block.timestamp);
    }

    /// @notice Remove the listing. Beneficial ownership is unchanged.
    function delist(uint256 tokenId) external {
        require(beneficialOwner[tokenId] == msg.sender, "not beneficial owner");
        require(listings[tokenId].active, "not listed");

        delete listings[tokenId];

        emit Delisted(tokenId);
    }

    /// @notice Relayer fills the listing. Sends paymentToken to the seller at reservePrice.
    ///         Relayer becomes the new beneficial owner and will receive inboundToken at settlement.
    ///         State is updated before token transfer for reentrancy safety.
    function fill(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        require(listing.active, "not listed");

        address seller = beneficialOwner[tokenId];

        // state changes before transfers
        delete listings[tokenId];
        beneficialOwner[tokenId] = msg.sender;

        IERC20(listing.paymentToken).transferFrom(msg.sender, seller, listing.reservePrice);

        emit Filled(tokenId, msg.sender, seller, listing.paymentToken, listing.reservePrice);
    }

    /// @notice Permissionless. Pays out inboundToken to the current beneficial owner and burns the NFT.
    ///         The contract must hold sufficient inboundToken (routed here by the CCTP bridge).
    ///         Handles the edge case where the NFT is still listed — the listing is cleared and
    ///         the seller receives the inbound tokens as if they had held to maturity.
    function settle(bytes32 cctpMessageHash) external {
        uint256 tokenId = tokenByMessageHash[cctpMessageHash];
        require(tokenId != 0, "unknown transfer");

        address recipient = beneficialOwner[tokenId];
        address token = nftData[tokenId].inboundToken;
        uint256 amount = nftData[tokenId].inboundAmount;

        // clean up all state before transfer
        delete beneficialOwner[tokenId];
        delete nftData[tokenId];
        delete listings[tokenId]; // handles: attestation arrives while NFT is still listed
        delete tokenByMessageHash[cctpMessageHash];
        _burn(tokenId);

        IERC20(token).transfer(recipient, amount);

        emit Settled(tokenId, recipient, token, amount);
    }
}
