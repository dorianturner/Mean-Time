// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IMockUSYC {
    function deposit(uint256 amount) external;
    function withdraw(uint256 shares) external;
}

contract ArcVelocity is ERC721, Ownable {
    IERC20 public usdc;
    IMockUSYC public usyc;
    
    uint256 public nextTokenId;
    
    struct TransferClaim {
        uint256 amount;
        bytes32 cctpNonce;
        uint256 expiry;
        bool settled;
        address originalSender;
    }

    mapping(uint256 => TransferClaim) public claims;
    mapping(bytes32 => uint256) public nonceToId;

    event ClaimMinted(uint256 indexed tokenId, address indexed sender, uint256 amount, bytes32 nonce);
    event ClaimSettled(uint256 indexed tokenId, address indexed receiver, uint256 amount);

    constructor(address _usdc, address _usyc) 
        ERC721("ArcVelocity Transfer Claim", "AVTC") 
        Ownable(msg.sender) 
    {
        usdc = IERC20(_usdc);
        usyc = IMockUSYC(_usyc);
    }

    /**
     * @notice Mints an NFT representing an "in-flight" USDC transfer.
     * @param _amount The amount of USDC burned on the source chain.
     * @param _nonce The CCTP nonce generated during the burn.
     */
    function initiateTransfer(uint256 _amount, bytes32 _nonce) external {
        uint256 tokenId = nextTokenId++;
        
        claims[tokenId] = TransferClaim({
            amount: _amount,
            cctpNonce: _nonce,
            expiry: block.timestamp + 24 hours,
            settled: false,
            originalSender: msg.sender
        });

        nonceToId[_nonce] = tokenId;

        _safeMint(msg.sender, tokenId);
        emit ClaimMinted(tokenId, msg.sender, _amount, _nonce);
    }

    /**
     * @notice Settles the claim once the CCTP attestation arrives.
     * @dev In a production environment, this would be called by the CCTP Relayer.
     * @param _tokenId The ID of the NFT to settle.
     */
    function settleTransfer(uint256 _tokenId) external {
        TransferClaim storage claim = claims[_tokenId];
        require(!claim.settled, "Already settled");
        require(ownerOf(_tokenId) != address(0), "Invalid token");

        address currentHolder = ownerOf(_tokenId);
        uint256 payoutAmount = claim.amount;

        // Mark as settled and burn the NFT
        claim.settled = true;
        _burn(_tokenId);

        // In the real version, we would verify the CCTP message here.
        // For the MVP, we assume the caller provides the correct USDC to this contract.
        require(usdc.transfer(currentHolder, payoutAmount), "Transfer failed");

        emit ClaimSettled(_tokenId, currentHolder, payoutAmount);
    }

    /**
     * @notice Optional: Logic to buy the NFT at a discount directly through the contract.
     */
    function buyClaim(uint256 _tokenId, uint256 _price) external {
        require(usdc.balanceOf(msg.sender) >= _price, "Insufficient USDC");
        address seller = ownerOf(_tokenId);
        
        // Transfer USDC from Buyer to Seller
        usdc.transferFrom(msg.sender, seller, _price);
        
        // Transfer the NFT (The "Claim") to the Buyer
        _transfer(seller, msg.sender, _tokenId);
    }
}