// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @title MeanTime
/// @notice Turns a pending CCTP transfer into a tradeable on-chain asset.
///
/// The idea is simple: when USDC is burned on Ethereum for delivery to Arc, there
/// is a ~17-minute wait for Circle's attestation. During that window the receiver
/// has a receivable — real economic value — but no way to use it. MeanTime mints
/// an NFT for that receivable, making it liquid immediately.
///
/// The receiver can hold the NFT and redeem the full USDC when it arrives, or they
/// can list it on the built-in marketplace. A relayer buys it (paying in EURC or
/// anything else the seller wants) and then waits out the attestation themselves,
/// earning the spread for their trouble.
///
/// Three design choices that everything else flows from:
///
///   1. The NFT never leaves this contract. Economic ownership is tracked in
///      `beneficialOwner` separately from ERC-721 ownership. This sidesteps
///      transfer hook complexity and makes settlement completely atomic.
///
///   2. Settlement is permissionless. Anyone can call settle() once USDC arrives.
///      The contract does not care who calls it — it just reads beneficialOwner
///      and pays them. This means relayers, keepers, or the receiver themselves
///      can all trigger settlement.
///
///   3. State is cleaned up before any token transfer (checks-effects-interactions).
///      The NFT is burned and all mappings cleared before USDC leaves the contract,
///      so there is no reentrancy surface.
contract MeanTime is ERC721 {
    using SafeERC20 for IERC20;
    using Strings for uint256;
    using Strings for address;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    // Access control
    error NotBridge();
    error NotBeneficialOwner();

    // Mint guards
    error AlreadyMinted();
    error InvalidToken();
    error InvalidAmount();
    error InvalidRecipient();

    // Marketplace guards
    error AlreadyListed();
    error InvalidPrice();
    error NotListed();

    // Settlement guards
    error UnknownTransfer();
    error InsufficientBalance();

    // -------------------------------------------------------------------------
    // Data types
    // -------------------------------------------------------------------------

    /// @notice Everything we know about an incoming transfer at mint time.
    /// @dev mintedAt is used as a proxy for attestation progress. The actual
    ///      attestation window depends on source-chain finality, so treat any
    ///      estimate as exactly that — an estimate.
    struct NFTData {
        bytes32 cctpMessageHash; // unique identifier linking this NFT to a specific CCTP message
        address inboundToken;    // which token will arrive (USDC, EURC, ...)
        uint256 inboundAmount;   // face value in token's native decimals (USDC: 6)
        uint256 mintedAt;        // block.timestamp at creation, used to track age
    }

    /// @notice A sell order posted by the current beneficial owner.
    /// @dev paymentToken is completely open — the seller picks whatever they want.
    ///      A USDC receiver can ask for EURC, or anything else liquid on Arc.
    struct Listing {
        uint256 reservePrice; // minimum the seller will accept, in paymentToken's decimals
        address paymentToken; // the token the seller wants to receive
        bool active;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Only this address can mint new receivables.
    /// @dev In production this is the backend bridge service, which watches for
    ///      CCTP burns on the source chain and calls mint() optimistically.
    address public bridge;

    /// @dev Start at 1 so that zero is a reliable "not found" sentinel in
    ///      tokenByMessageHash. A mapping default of 0 means "no token".
    uint256 private _nextTokenId = 1;

    mapping(uint256 tokenId => NFTData) public nftData;
    mapping(uint256 tokenId => Listing) public listings;

    /// @notice The address that will receive inboundToken when this NFT settles.
    ///         This is what changes when a relayer fills a listing — not ERC-721
    ///         ownership, which always stays with address(this).
    mapping(uint256 tokenId => address) public beneficialOwner;

    /// @notice Reverse lookup from CCTP message hash to token ID.
    ///         Used by settle() so the backend only needs to pass the message hash.
    mapping(bytes32 messageHash => uint256 tokenId) public tokenByMessageHash;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice A CCTP burn was detected and an NFT was minted for the incoming transfer.
    event Minted(
        uint256 indexed tokenId,
        address indexed recipient,
        address inboundToken,
        uint256 inboundAmount,
        bytes32 cctpMessageHash
    );

    /// @notice The beneficial owner has put this receivable up for sale.
    event Listed(uint256 indexed tokenId, uint256 reservePrice, address paymentToken, uint256 listedAt);

    /// @notice The listing was removed. Beneficial ownership is unchanged.
    event Delisted(uint256 indexed tokenId);

    /// @notice A relayer bought the receivable. They are now the beneficial owner
    ///         and will receive inboundToken at settlement.
    event Filled(
        uint256 indexed tokenId,
        address indexed relayer,
        address indexed seller,
        address paymentToken,
        uint256 amount,
        uint256 filledAt // seconds elapsed since mint, useful for pricing analysis
    );

    /// @notice The CCTP attestation arrived and inboundToken was paid to the
    ///         current beneficial owner. The NFT is burned. The lifecycle is complete.
    event Settled(uint256 indexed tokenId, address indexed recipient, address inboundToken, uint256 amount);

    /// @notice Diagnostic event emitted at the start of every settle attempt.
    ///         Useful for debugging when settlement fails — emitted before any
    ///         state changes so the data reflects pre-settlement conditions.
    event SettleAttempted(
        uint256 indexed tokenId,
        address indexed beneficiary,
        address inboundToken,
        uint256 inboundAmount,
        uint256 blockTimestamp,
        uint256 maturityTimestamp,
        uint256 contractBalance
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _bridge) ERC721("MeanTime Receivable", "MTR") {
        bridge = _bridge;
    }

    // -------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------

    modifier onlyBridge() {
        if (msg.sender != bridge) revert NotBridge();
        _;
    }

    // -------------------------------------------------------------------------
    // Core lifecycle
    // -------------------------------------------------------------------------

    /// @notice Register a pending CCTP transfer as a tradeable NFT.
    ///
    /// Called by the bridge service as soon as a burn is detected on the source
    /// chain — before Circle's attestation, before USDC actually arrives. The NFT
    /// is "backed" by the incoming transfer, not by tokens already in the contract.
    ///
    /// @param cctpMessageHash  keccak256 of the raw CCTP message bytes. This is
    ///                         the canonical identifier for the transfer.
    /// @param inboundToken     ERC-20 address of the token that will arrive.
    /// @param inboundAmount    Face value in the token's native decimals.
    /// @param recipient        Who should receive the tokens at settlement if
    ///                         nobody buys the receivable first.
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

    /// @notice List this receivable for sale on the built-in marketplace.
    ///
    /// The seller picks their price and payment token. The NFT stays in the
    /// contract — only the listing record is created. Beneficial ownership does
    /// not change until a relayer fills the order.
    ///
    /// To update price or token: delist() then list() again. On Arc with
    /// sub-second finality this is effectively atomic.
    ///
    /// @param tokenId       The receivable to list.
    /// @param reservePrice  Minimum amount the seller will accept.
    /// @param paymentToken  Token the seller wants in return (any ERC-20).
    function list(uint256 tokenId, uint256 reservePrice, address paymentToken) external {
        if (beneficialOwner[tokenId] != msg.sender) revert NotBeneficialOwner();
        if (listings[tokenId].active) revert AlreadyListed();
        if (reservePrice == 0) revert InvalidPrice();
        if (paymentToken == address(0)) revert InvalidToken();

        listings[tokenId] = Listing({reservePrice: reservePrice, paymentToken: paymentToken, active: true});

        emit Listed(tokenId, reservePrice, paymentToken, block.timestamp);
    }

    /// @notice Remove a listing. Everything else stays the same.
    function delist(uint256 tokenId) external {
        if (beneficialOwner[tokenId] != msg.sender) revert NotBeneficialOwner();
        if (!listings[tokenId].active) revert NotListed();

        delete listings[tokenId];

        emit Delisted(tokenId);
    }

    /// @notice Fill a listed receivable. The relayer pays the seller and becomes
    ///         the new beneficial owner, entitled to receive inboundToken at settlement.
    ///
    /// The relayer earns the spread between what they pay the seller and the face
    /// value of the USDC they will receive. The larger the remaining attestation
    /// window, the larger the spread needs to be to compensate for FX risk.
    ///
    /// State is updated before the token transfer so this is safe against reentrancy.
    ///
    /// @param tokenId  The receivable to fill. Relayer must have approved this
    ///                 contract to spend listing.reservePrice of listing.paymentToken.
    function fill(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        if (!listing.active) revert NotListed();

        address seller = beneficialOwner[tokenId];

        // Update state first, then transfer. This ordering is not paranoia —
        // it is the only correct ordering when calling into external contracts.
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

    /// @notice Settle a receivable by its CCTP message hash.
    ///
    /// Permissionless — anyone can call this. The contract reads beneficialOwner
    /// and pays them. It does not matter who initiates settlement. In practice the
    /// backend calls this as soon as it detects the Circle attestation is complete.
    ///
    /// @param cctpMessageHash  The hash of the original CCTP message bytes.
    function settle(bytes32 cctpMessageHash) public {
        uint256 tokenId = tokenByMessageHash[cctpMessageHash];
        if (tokenId == 0) revert UnknownTransfer();

        _settle(tokenId, cctpMessageHash);
    }

    /// @notice Settle a receivable by token ID instead of message hash.
    ///
    /// Convenience alternative to settle(). Useful when you have the tokenId
    /// but not the original message hash.
    ///
    /// @param tokenId  The receivable to settle.
    function claim(uint256 tokenId) external {
        NFTData memory data = nftData[tokenId];
        if (data.mintedAt == 0) revert UnknownTransfer();

        _settle(tokenId, data.cctpMessageHash);
    }

    // -------------------------------------------------------------------------
    // Internal settlement logic
    // -------------------------------------------------------------------------

    /// @dev The actual settlement logic, shared by settle() and claim().
    ///
    /// The ordering here is load-bearing:
    ///   1. Read everything we need from storage.
    ///   2. Emit diagnostic event (before cleanup, so data is still readable).
    ///   3. Check the contract has enough tokens to pay out.
    ///   4. Delete all state and burn the NFT.
    ///   5. Transfer tokens.
    ///   6. Emit settled event.
    ///
    /// Steps 4 and 5 in that order is the checks-effects-interactions pattern.
    /// The NFT is gone before any external call happens.
    function _settle(uint256 tokenId, bytes32 cctpMessageHash) internal {
        address recipient = beneficialOwner[tokenId];
        address token = nftData[tokenId].inboundToken;
        uint256 amount = nftData[tokenId].inboundAmount;
        uint256 mintedAt = nftData[tokenId].mintedAt;

        // Emit diagnostic data before we wipe storage, so if this reverts
        // (e.g. insufficient balance) the event is still readable in the trace.
        uint256 contractBalance = IERC20(token).balanceOf(address(this));
        emit SettleAttempted(
            tokenId, recipient, token, amount, block.timestamp, mintedAt + ESTIMATED_ATTESTATION_TIME, contractBalance
        );

        // Fail early with a clear error rather than letting SafeERC20 revert
        // with a confusing transfer failure message.
        if (contractBalance < amount) revert InsufficientBalance();

        // Clean up all state before transferring tokens.
        // The `delete listings[tokenId]` handles the edge case where the Circle
        // attestation arrives while the NFT is still listed but unfilled —
        // the listing becomes moot and the beneficial owner gets paid regardless.
        delete beneficialOwner[tokenId];
        delete nftData[tokenId];
        delete listings[tokenId];
        delete tokenByMessageHash[cctpMessageHash];
        _burn(tokenId);

        // Now we can safely call into the token contract.
        // For Arc USDC at 0x3600..., this is the 6-decimal ERC-20 interface.
        IERC20(token).safeTransfer(recipient, amount);

        emit Settled(tokenId, recipient, token, amount);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /// @notice Circle's attestation takes roughly 17 minutes from the source burn.
    ///         This is used as an estimate only — actual time varies with Ethereum
    ///         block times and Circle's processing load.
    uint256 public constant ESTIMATED_ATTESTATION_TIME = 1020; // seconds

    /// @notice Get the full state of a receivable in a single call.
    ///         Saves frontends and relayers from making four separate calls.
    ///
    /// @return owner                The current beneficial owner.
    /// @return data                 NFT data: hash, token, amount, mintedAt.
    /// @return listing              Current listing (check listing.active).
    /// @return age                  Seconds elapsed since mint.
    /// @return estimatedSecondsLeft Estimated seconds until attestation (0 if past estimate).
    function getReceivable(uint256 tokenId)
        external
        view
        returns (
            address owner,
            NFTData memory data,
            Listing memory listing,
            uint256 age,
            uint256 estimatedSecondsLeft
        )
    {
        owner = beneficialOwner[tokenId];
        data = nftData[tokenId];
        listing = listings[tokenId];
        age = _age(data.mintedAt);
        // Guard on mintedAt > 0 so burned/nonexistent tokens return 0 rather than
        // the full ESTIMATED_ATTESTATION_TIME (which would happen because age=0 < 1020).
        estimatedSecondsLeft =
            (data.mintedAt > 0 && age < ESTIMATED_ATTESTATION_TIME) ? ESTIMATED_ATTESTATION_TIME - age : 0;
    }

    /// @notice Estimated Unix timestamp when this receivable will be ready to settle.
    ///         Returns 0 for burned or nonexistent tokens.
    function estimatedSettleTime(uint256 tokenId) external view returns (uint256) {
        uint256 minted = nftData[tokenId].mintedAt;
        return minted > 0 ? minted + ESTIMATED_ATTESTATION_TIME : 0;
    }

    // -------------------------------------------------------------------------
    // ERC-721 metadata (fully on-chain)
    // -------------------------------------------------------------------------

    /// @notice Returns a data URI containing JSON metadata and an inline SVG image.
    ///         Everything is computed on-chain — no external dependencies.
    ///
    ///         The SVG shows: face value, token address, age, estimated time
    ///         remaining, listing status, and an attestation progress bar.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        NFTData memory data = nftData[tokenId];
        // Return empty for burned tokens rather than reverting.
        // This keeps indexers happy when they encounter old token IDs.
        if (data.mintedAt == 0) return "";

        uint256 age = _age(data.mintedAt);
        uint256 secsLeft = age < ESTIMATED_ATTESTATION_TIME ? ESTIMATED_ATTESTATION_TIME - age : 0;
        bool ready = secsLeft == 0;
        Listing memory listing = listings[tokenId];

        string memory amountStr = _formatDecimals6(data.inboundAmount);
        string memory ageStr = _formatDuration(age);
        string memory remainStr = ready ? "READY" : _formatDuration(secsLeft);
        string memory progressPct =
            age >= ESTIMATED_ATTESTATION_TIME ? "100" : (age * 100 / ESTIMATED_ATTESTATION_TIME).toString();
        string memory listingStr =
            listing.active ? string.concat(_formatDecimals6(listing.reservePrice), " (listed)") : "Not listed";
        string memory barColor = ready ? "#22c55e" : "#3b82f6";

        string memory svg = _buildSvg(tokenId, amountStr, data, ageStr, remainStr, listingStr, barColor, progressPct, age);
        string memory json = _buildJson(tokenId, amountStr, svg, age, secsLeft, listing);

        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // -------------------------------------------------------------------------
    // Private pure helpers
    // -------------------------------------------------------------------------

    /// @dev Age of a receivable in seconds. Returns 0 if not yet minted or if
    ///      the block timestamp is somehow behind mintedAt (shouldn't happen, but
    ///      Arc blocks can share timestamps so we guard the subtraction).
    function _age(uint256 mintedAt) private view returns (uint256) {
        if (mintedAt == 0 || block.timestamp < mintedAt) return 0;
        return block.timestamp - mintedAt;
    }

    /// @dev Format a 6-decimal fixed-point integer as "1234.567890".
    function _formatDecimals6(uint256 value) private pure returns (string memory) {
        uint256 whole = value / 1e6;
        uint256 frac = value % 1e6;
        bytes memory padded = new bytes(6);
        bytes memory fracBytes = bytes(frac.toString());
        uint256 padLen = 6 - fracBytes.length;
        for (uint256 i = 0; i < 6; i++) {
            padded[i] = i < padLen ? bytes1("0") : fracBytes[i - padLen];
        }
        return string.concat(whole.toString(), ".", string(padded));
    }

    /// @dev Format a duration in seconds as "4m 17s".
    function _formatDuration(uint256 secs) private pure returns (string memory) {
        return string.concat((secs / 60).toString(), "m ", (secs % 60).toString(), "s");
    }

    /// @dev Build the SVG image for the token metadata.
    function _buildSvg(
        uint256 tokenId,
        string memory amountStr,
        NFTData memory data,
        string memory ageStr,
        string memory remainStr,
        string memory listingStr,
        string memory barColor,
        string memory progressPct,
        uint256 age
    ) private pure returns (string memory svg) {
        svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250" style="background:#0f172a;font-family:monospace">',
            '<text x="20" y="35" font-size="18" fill="#e2e8f0" font-weight="bold">MeanTime Receivable #',
            tokenId.toString(),
            "</text>",
            '<text x="20" y="70" font-size="14" fill="#94a3b8">Face Value</text>',
            '<text x="200" y="70" font-size="14" fill="#f8fafc">',
            amountStr,
            "</text>",
            '<text x="20" y="95" font-size="14" fill="#94a3b8">Token</text>',
            '<text x="200" y="95" font-size="11" fill="#f8fafc">',
            data.inboundToken.toChecksumHexString(),
            "</text>",
            '<text x="20" y="120" font-size="14" fill="#94a3b8">Age</text>',
            '<text x="200" y="120" font-size="14" fill="#f8fafc">',
            ageStr,
            "</text>",
            '<text x="20" y="145" font-size="14" fill="#94a3b8">Est. Remaining</text>',
            '<text x="200" y="145" font-size="14" fill="',
            barColor,
            '">',
            remainStr,
            "</text>",
            '<text x="20" y="170" font-size="14" fill="#94a3b8">Listing</text>',
            '<text x="200" y="170" font-size="14" fill="#f8fafc">',
            listingStr,
            "</text>",
            '<rect x="20" y="195" width="360" height="16" rx="8" fill="#1e293b"/>',
            '<rect x="20" y="195" width="',
            (age >= ESTIMATED_ATTESTATION_TIME ? 360 : age * 360 / ESTIMATED_ATTESTATION_TIME).toString(),
            '" height="16" rx="8" fill="',
            barColor,
            '"/>',
            '<text x="20" y="235" font-size="11" fill="#64748b">',
            progressPct,
            "% to attestation</text>",
            "</svg>"
        );
    }

    /// @dev Build the JSON metadata string for the token.
    function _buildJson(
        uint256 tokenId,
        string memory amountStr,
        string memory svg,
        uint256 age,
        uint256 secsLeft,
        Listing memory listing
    ) private pure returns (string memory) {
        return string.concat(
            '{"name":"MeanTime Receivable #',
            tokenId.toString(),
            '","description":"Tokenised CCTP receivable. Face value: ',
            amountStr,
            '","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '","attributes":[',
            '{"trait_type":"Face Value","value":"',
            amountStr,
            '"},{"trait_type":"Age (seconds)","display_type":"number","value":',
            age.toString(),
            '},{"trait_type":"Est. Seconds Remaining","display_type":"number","value":',
            secsLeft.toString(),
            '},{"trait_type":"Listed","value":"',
            listing.active ? "Yes" : "No",
            '"}]}'
        );
    }
}
