// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title MeanTime — Tokenised CCTP receivables
/// @notice Every CCTP inbound transfer is represented as an NFT held by this contract.
///         Economic ownership is tracked via beneficialOwner. The NFT never leaves the contract.
contract MeanTime is ERC721 {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    // ── Errors ─────────────────────────────────────────────────────────────────

    error NotBridge();
    error AlreadyMinted();
    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();
    error NotBeneficialOwner();
    error AlreadyListed();
    error InvalidPrice();
    error NotListed();
    error UnknownTransfer();

    // ── Storage ────────────────────────────────────────────────────────────────

    /// @notice The authorised bridge address — the only address that can call mint().
    address public bridge;

    /// @dev Start at 1 so that tokenId 0 is a reliable sentinel for "not found"
    ///      in the tokenByMessageHash mapping.
    uint256 private _nextTokenId = 1;

    struct NFTData {
        bytes32 cctpMessageHash; // links this NFT to a specific CCTP transfer
        address inboundToken; // the token that will arrive at attestation (e.g. USDC, EURC)
        uint256 inboundAmount; // face value, in units of inboundToken
        uint256 mintedAt; // block.timestamp at mint — proxy for attestation progress
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
        uint256 amount,
        uint256 filledAt
    );
    event Settled(uint256 indexed tokenId, address indexed recipient, address inboundToken, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _bridge) ERC721("MeanTime Receivable", "MTR") {
        bridge = _bridge;
    }

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyBridge() {
        if (msg.sender != bridge) revert NotBridge();
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
        if (tokenByMessageHash[cctpMessageHash] != 0) revert AlreadyMinted();
        if (inboundToken == address(0)) revert InvalidToken();
        if (inboundAmount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        tokenId = _nextTokenId++;
        _mint(address(this), tokenId);

        nftData[tokenId] = NFTData({
            cctpMessageHash: cctpMessageHash,
            inboundToken: inboundToken,
            inboundAmount: inboundAmount,
            mintedAt: block.timestamp
        });

        beneficialOwner[tokenId] = recipient;
        tokenByMessageHash[cctpMessageHash] = tokenId;

        emit Minted(tokenId, recipient, inboundToken, inboundAmount, cctpMessageHash);
    }

    /// @notice List the receivable NFT for sale. The seller specifies the minimum price
    ///         and which token they want to receive. The NFT stays in the contract.
    function list(uint256 tokenId, uint256 reservePrice, address paymentToken) external {
        if (beneficialOwner[tokenId] != msg.sender) revert NotBeneficialOwner();
        if (listings[tokenId].active) revert AlreadyListed();
        if (reservePrice == 0) revert InvalidPrice();
        if (paymentToken == address(0)) revert InvalidToken();

        listings[tokenId] = Listing({reservePrice: reservePrice, paymentToken: paymentToken, active: true});

        emit Listed(tokenId, reservePrice, paymentToken, block.timestamp);
    }

    /// @notice Remove the listing. Beneficial ownership is unchanged.
    function delist(uint256 tokenId) external {
        if (beneficialOwner[tokenId] != msg.sender) revert NotBeneficialOwner();
        if (!listings[tokenId].active) revert NotListed();

        delete listings[tokenId];

        emit Delisted(tokenId);
    }

    /// @notice Relayer fills the listing. Sends paymentToken to the seller at reservePrice.
    ///         Relayer becomes the new beneficial owner and will receive inboundToken at settlement.
    ///         State is updated before token transfer for reentrancy safety.
    function fill(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        if (!listing.active) revert NotListed();

        address seller = beneficialOwner[tokenId];

        // state changes before transfers
        delete listings[tokenId];
        beneficialOwner[tokenId] = msg.sender;

        IERC20(listing.paymentToken).safeTransferFrom(msg.sender, seller, listing.reservePrice);

        emit Filled(
            tokenId,
            msg.sender,
            seller,
            listing.paymentToken,
            listing.reservePrice,
            block.timestamp - nftData[tokenId].mintedAt
        );
    }

    /// @notice Permissionless. Pays out inboundToken to the current beneficial owner and burns the NFT.
    ///         The contract must hold sufficient inboundToken (routed here by the CCTP bridge).
    ///         Handles the edge case where the NFT is still listed — the listing is cleared and
    ///         the seller receives the inbound tokens as if they had held to maturity.
    function settle(bytes32 cctpMessageHash) external {
        uint256 tokenId = tokenByMessageHash[cctpMessageHash];
        if (tokenId == 0) revert UnknownTransfer();

        address recipient = beneficialOwner[tokenId];
        address token = nftData[tokenId].inboundToken;
        uint256 amount = nftData[tokenId].inboundAmount;

        // clean up all state before transfer
        delete beneficialOwner[tokenId];
        delete nftData[tokenId];
        delete listings[tokenId]; // handles: attestation arrives while NFT is still listed
        delete tokenByMessageHash[cctpMessageHash];
        _burn(tokenId);

        IERC20(token).safeTransfer(recipient, amount);

        emit Settled(tokenId, recipient, token, amount);
    }

    // ── View functions ─────────────────────────────────────────────────────────

    /// @notice Estimated attestation window in seconds (~17 minutes).
    uint256 public constant ESTIMATED_ATTESTATION_TIME = 1020;

    /// @notice Returns the full state of a receivable in a single call.
    /// @param tokenId The NFT token ID.
    /// @return owner The current beneficial owner.
    /// @return data The NFT data (messageHash, inboundToken, inboundAmount, mintedAt).
    /// @return listing The current listing (reservePrice, paymentToken, active).
    /// @return age Seconds elapsed since mint.
    /// @return estimatedSecondsLeft Estimated seconds until attestation (0 if past estimate).
    function getReceivable(uint256 tokenId)
        external
        view
        returns (address owner, NFTData memory data, Listing memory listing, uint256 age, uint256 estimatedSecondsLeft)
    {
        owner = beneficialOwner[tokenId];
        data = nftData[tokenId];
        listing = listings[tokenId];
        age = data.mintedAt > 0 ? block.timestamp - data.mintedAt : 0;
        estimatedSecondsLeft =
            (data.mintedAt > 0 && age < ESTIMATED_ATTESTATION_TIME) ? ESTIMATED_ATTESTATION_TIME - age : 0;
    }

    /// @notice Convenience: estimated settlement timestamp for a receivable.
    /// @return timestamp Unix timestamp when attestation is expected (mintedAt + 1020s).
    ///         Returns 0 if the tokenId has no data (burned or never existed).
    function estimatedSettleTime(uint256 tokenId) external view returns (uint256 timestamp) {
        uint256 minted = nftData[tokenId].mintedAt;
        timestamp = minted > 0 ? minted + ESTIMATED_ATTESTATION_TIME : 0;
    }

    // ── ERC-721 metadata ───────────────────────────────────────────────────────

    /// @notice Returns a fully on-chain data URI with JSON metadata and an SVG image.
    ///         Shows face value, inbound token, age, time remaining, and listing status.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        NFTData memory data = nftData[tokenId];
        // Return empty for burned / nonexistent tokens rather than revert, so indexers don't break.
        if (data.mintedAt == 0) return "";

        uint256 age = block.timestamp - data.mintedAt;
        uint256 secsLeft = age < ESTIMATED_ATTESTATION_TIME ? ESTIMATED_ATTESTATION_TIME - age : 0;
        Listing memory listing = listings[tokenId];

        // ── Build human-readable strings ───────────────────────────────────
        string memory amountStr = _formatDecimals6(data.inboundAmount);
        string memory ageStr = _formatDuration(age);
        string memory remainStr = secsLeft > 0 ? _formatDuration(secsLeft) : "READY";
        string memory progressPct =
            (age >= ESTIMATED_ATTESTATION_TIME) ? "100" : (age * 100 / ESTIMATED_ATTESTATION_TIME).toString();
        string memory listingStr =
            listing.active ? string.concat(_formatDecimals6(listing.reservePrice), " (listed)") : "Not listed";
        string memory barColor = secsLeft == 0 ? "#22c55e" : "#3b82f6";

        // ── SVG ────────────────────────────────────────────────────────────
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" style="background:#0f172a;font-family:monospace">',
            '<text x="20" y="35" font-size="18" fill="#e2e8f0" font-weight="bold">MeanTime Receivable #',
            tokenId.toString(),
            "</text>",
            '<text x="20" y="70" font-size="14" fill="#94a3b8">Face Value</text>',
            '<text x="200" y="70" font-size="14" fill="#f8fafc">',
            amountStr,
            "</text>"
        );

        svg = string.concat(
            svg,
            '<text x="20" y="95" font-size="14" fill="#94a3b8">Token</text>',
            '<text x="200" y="95" font-size="11" fill="#f8fafc">',
            data.inboundToken.toChecksumHexString(),
            "</text>",
            '<text x="20" y="120" font-size="14" fill="#94a3b8">Age</text>',
            '<text x="200" y="120" font-size="14" fill="#f8fafc">',
            ageStr,
            "</text>"
        );

        svg = string.concat(
            svg,
            '<text x="20" y="145" font-size="14" fill="#94a3b8">Est. Remaining</text>',
            '<text x="200" y="145" font-size="14" fill="',
            barColor,
            '">',
            remainStr,
            "</text>",
            '<text x="20" y="170" font-size="14" fill="#94a3b8">Listing</text>',
            '<text x="200" y="170" font-size="14" fill="#f8fafc">',
            listingStr,
            "</text>"
        );

        // Progress bar
        svg = string.concat(
            svg,
            '<rect x="20" y="195" width="360" height="16" rx="8" fill="#1e293b"/>',
            '<rect x="20" y="195" width="',
            (age >= ESTIMATED_ATTESTATION_TIME) ? "360" : (age * 360 / ESTIMATED_ATTESTATION_TIME).toString(),
            '" height="16" rx="8" fill="',
            barColor,
            '"/>',
            '<text x="20" y="235" font-size="11" fill="#64748b">',
            progressPct,
            "% to attestation</text>",
            "</svg>"
        );

        // ── JSON metadata ──────────────────────────────────────────────────
        string memory json = string.concat(
            '{"name":"MeanTime Receivable #',
            tokenId.toString(),
            '","description":"Tokenised CCTP receivable. Face value: ',
            amountStr,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '","attributes":[{"trait_type":"Face Value","value":"',
            amountStr
        );

        json = string.concat(
            json,
            '"},{"trait_type":"Age (seconds)","display_type":"number","value":',
            age.toString(),
            '},{"trait_type":"Est. Seconds Remaining","display_type":"number","value":',
            secsLeft.toString(),
            '},{"trait_type":"Listed","value":"',
            listing.active ? "Yes" : "No",
            '"}]}'
        );

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    /// @dev Format a uint with 6-decimal precision into a human-readable string (e.g. 1000000000 → "1000.000000").
    function _formatDecimals6(uint256 value) internal pure returns (string memory) {
        uint256 whole = value / 1e6;
        uint256 frac = value % 1e6;
        // Pad fractional part to 6 digits
        string memory fracStr = frac.toString();
        bytes memory padded = new bytes(6);
        bytes memory fracBytes = bytes(fracStr);
        uint256 padLen = 6 - fracBytes.length;
        for (uint256 i = 0; i < 6; i++) {
            padded[i] = i < padLen ? bytes1("0") : fracBytes[i - padLen];
        }
        return string.concat(whole.toString(), ".", string(padded));
    }

    /// @dev Format seconds into "Xm Ys" string.
    function _formatDuration(uint256 secs) internal pure returns (string memory) {
        uint256 m = secs / 60;
        uint256 s = secs % 60;
        return string.concat(m.toString(), "m ", s.toString(), "s");
    }
}
