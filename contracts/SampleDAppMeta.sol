// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MetaTxRecipient.sol";

/**
 * @title SampleDAppMeta
 * @author Web3Assam Gas Optimizer Team
 * @notice EIP-2771 compatible version of SampleDApp for true gasless transactions
 * @dev Inherits MetaTxRecipient to support Forwarder-based meta-transactions
 * 
 * KEY DIFFERENCE FROM SampleDApp:
 * - Uses _msgSender() instead of msg.sender
 * - Works with Forwarder for true gasless UX where the user's address is preserved
 * 
 * USE CASE: NFT Marketplace with gasless transactions
 * - Users sign transactions off-chain
 * - Relayer submits via Forwarder
 * - User's address is correctly identified in all functions
 */
contract SampleDAppMeta is MetaTxRecipient {
    
    // ============ STRUCTS ============
    
    struct UserProfile {
        string username;
        string bio;
        uint256 reputation;
        uint256 totalTransactions;
        bool isVerified;
    }

    struct Listing {
        address seller;
        string itemName;
        uint256 price;
        bool isActive;
        uint256 createdAt;
    }

    struct Bid {
        address bidder;
        uint256 amount;
        uint256 timestamp;
    }

    // ============ STATE VARIABLES ============
    
    mapping(address => UserProfile) public profiles;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Bid[]) public listingBids;
    mapping(address => uint256[]) public userListings;
    mapping(address => uint256) public userBalances;
    
    uint256 public nextListingId;
    uint256 public totalListings;
    uint256 public totalBids;

    // ============ EVENTS ============
    
    event ProfileUpdated(address indexed user, string username);
    event ListingCreated(uint256 indexed listingId, address indexed seller, string itemName, uint256 price);
    event ListingUpdated(uint256 indexed listingId, uint256 newPrice);
    event ListingCancelled(uint256 indexed listingId);
    event BidPlaced(uint256 indexed listingId, address indexed bidder, uint256 amount);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    // ============ CONSTRUCTOR ============

    constructor(address _trustedForwarder) MetaTxRecipient(_trustedForwarder) {}

    // ============ PROFILE FUNCTIONS ============

    /**
     * @notice Create or update user profile
     * @dev Uses _msgSender() to support meta-transactions
     * @param username User's display name
     * @param bio User's biography
     */
    function updateProfile(string calldata username, string calldata bio) external {
        address sender = _msgSender();
        profiles[sender].username = username;
        profiles[sender].bio = bio;
        emit ProfileUpdated(sender, username);
    }

    /**
     * @notice Set user verification status (admin function in real app)
     * @param user User to verify
     * @param verified Verification status
     */
    function setVerified(address user, bool verified) external {
        profiles[user].isVerified = verified;
    }

    // ============ LISTING FUNCTIONS ============

    /**
     * @notice Create a new listing
     * @dev Uses _msgSender() to support meta-transactions
     * @param itemName Name of the item
     * @param price Price in wei
     * @return listingId The ID of the created listing
     */
    function createListing(string calldata itemName, uint256 price) 
        external 
        returns (uint256 listingId) 
    {
        address sender = _msgSender();
        listingId = nextListingId++;
        
        listings[listingId] = Listing({
            seller: sender,
            itemName: itemName,
            price: price,
            isActive: true,
            createdAt: block.timestamp
        });

        userListings[sender].push(listingId);
        totalListings++;

        profiles[sender].totalTransactions++;

        emit ListingCreated(listingId, sender, itemName, price);
    }

    /**
     * @notice Update listing price
     * @param listingId ID of the listing
     * @param newPrice New price
     */
    function updateListing(uint256 listingId, uint256 newPrice) external {
        address sender = _msgSender();
        require(listings[listingId].seller == sender, "Not seller");
        require(listings[listingId].isActive, "Listing not active");
        
        listings[listingId].price = newPrice;
        emit ListingUpdated(listingId, newPrice);
    }

    /**
     * @notice Cancel a listing
     * @param listingId ID of the listing
     */
    function cancelListing(uint256 listingId) external {
        address sender = _msgSender();
        require(listings[listingId].seller == sender, "Not seller");
        listings[listingId].isActive = false;
        emit ListingCancelled(listingId);
    }

    /**
     * @notice Create multiple listings in one call
     * @param itemNames Array of item names
     * @param prices Array of prices
     * @return listingIds Array of created listing IDs
     */
    function createMultipleListings(
        string[] calldata itemNames, 
        uint256[] calldata prices
    ) 
        external 
        returns (uint256[] memory listingIds) 
    {
        require(itemNames.length == prices.length, "Array length mismatch");
        
        address sender = _msgSender();
        listingIds = new uint256[](itemNames.length);
        
        for (uint256 i = 0; i < itemNames.length; i++) {
            uint256 listingId = nextListingId++;
            
            listings[listingId] = Listing({
                seller: sender,
                itemName: itemNames[i],
                price: prices[i],
                isActive: true,
                createdAt: block.timestamp
            });

            userListings[sender].push(listingId);
            listingIds[i] = listingId;
            
            emit ListingCreated(listingId, sender, itemNames[i], prices[i]);
        }

        totalListings += itemNames.length;
        profiles[sender].totalTransactions += itemNames.length;
    }

    // ============ BIDDING FUNCTIONS ============

    /**
     * @notice Place a bid on a listing
     * @param listingId ID of the listing
     */
    function placeBid(uint256 listingId) external payable {
        address sender = _msgSender();
        require(listings[listingId].isActive, "Listing not active");
        require(msg.value > 0, "Bid must be positive");

        listingBids[listingId].push(Bid({
            bidder: sender,
            amount: msg.value,
            timestamp: block.timestamp
        }));

        totalBids++;
        profiles[sender].totalTransactions++;

        emit BidPlaced(listingId, sender, msg.value);
    }

    /**
     * @notice Get bids for a listing
     * @param listingId ID of the listing
     * @return Array of bids
     */
    function getBids(uint256 listingId) external view returns (Bid[] memory) {
        return listingBids[listingId];
    }

    // ============ BALANCE FUNCTIONS ============

    /**
     * @notice Deposit ETH to user balance
     */
    function deposit() external payable {
        address sender = _msgSender();
        userBalances[sender] += msg.value;
        emit Deposited(sender, msg.value);
    }

    /**
     * @notice Withdraw ETH from user balance
     * @param amount Amount to withdraw
     */
    function withdraw(uint256 amount) external {
        address sender = _msgSender();
        require(userBalances[sender] >= amount, "Insufficient balance");
        userBalances[sender] -= amount;
        payable(sender).transfer(amount);
        emit Withdrawn(sender, amount);
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Get user profile
     * @param user User address
     * @return UserProfile struct
     */
    function getProfile(address user) external view returns (UserProfile memory) {
        return profiles[user];
    }

    /**
     * @notice Get listing details
     * @param listingId ID of the listing
     * @return Listing struct
     */
    function getListing(uint256 listingId) external view returns (Listing memory) {
        return listings[listingId];
    }

    /**
     * @notice Get user's listing IDs
     * @param user User address
     * @return Array of listing IDs
     */
    function getUserListings(address user) external view returns (uint256[] memory) {
        return userListings[user];
    }

    /**
     * @notice Get statistics
     * @return _totalListings Total number of listings
     * @return _totalBids Total number of bids
     * @return _nextListingId Next listing ID
     */
    function getStats() external view returns (
        uint256 _totalListings,
        uint256 _totalBids,
        uint256 _nextListingId
    ) {
        return (totalListings, totalBids, nextListingId);
    }
}
