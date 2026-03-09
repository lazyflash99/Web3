// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GasSponsor
 * @author Web3Assam Gas Optimizer Team
 * @notice Manages gas sponsorship for users executing transactions through the BatchExecutor
 * @dev Provides flexible sponsorship models: full, partial, and quota-based
 *
 * SPONSORSHIP MODELS:
 * 1. Full Sponsorship - Sponsor pays 100% of gas costs
 * 2. Partial Sponsorship - Sponsor pays a percentage of gas costs
 * 3. Quota-based - Users get a gas quota that depletes with usage
 * 4. Whitelist-based - Only whitelisted users get sponsored
 * 5. Key-based - Users redeem a sponsor key to self-whitelist
 *
 * RATE LIMITING:
 * - maxTxPerDay limits how many sponsored transactions a user can make per 24h
 * - maxGasPerDay limits total gas sponsored per user per 24h
 */
contract GasSponsor is Ownable, ReentrancyGuard {
    // ============ STRUCTS ============

    /// @notice Sponsorship configuration
    struct SponsorshipConfig {
        bool isActive; // Whether sponsorship is active
        uint256 maxGasPerTx; // Maximum gas to sponsor per transaction
        uint256 maxGasPerDay; // Maximum gas to sponsor per day per user
        uint256 sponsorshipPercent; // Percentage of gas to sponsor (0-100)
        uint256 minBalance; // Minimum sponsor balance to continue
    }

    /// @notice User's sponsorship quota (packed into 2 storage slots)
    struct UserQuota {
        uint128 totalSponsored; // Total gas sponsored for this user
        uint128 dailyUsed; // Gas used today
        uint48 lastResetTime; // When daily quota was last reset
        uint16 dailyTxCount; // Number of sponsored txs today
        bool isWhitelisted; // Whether user is whitelisted for sponsorship
    }

    /// @notice Relayer info
    struct Relayer {
        bool isActive; // Whether relayer is active
        uint256 totalGasSponsored; // Total gas this relayer has had sponsored
        uint256 pendingReimbursement; // Pending reimbursement amount
    }

    // ============ STATE VARIABLES ============

    /// @notice Main sponsorship configuration
    SponsorshipConfig public config;

    /// @notice Mapping of user addresses to their quota
    mapping(address => UserQuota) public userQuotas;

    /// @notice Mapping of relayer addresses to their info
    mapping(address => Relayer) public relayers;

    /// @notice Address of the batch executor contract
    address public batchExecutor;

    /// @notice Total gas sponsored across all users
    uint256 public totalGasSponsored;

    /// @notice Total ETH spent on sponsorship
    uint256 public totalEthSpent;

    /// @notice Whether whitelist mode is enabled
    bool public whitelistOnly;

    /// @notice Hash of the sponsor key (users redeem this to self-whitelist)
    bytes32 public sponsorKeyHash;

    /// @notice Maximum sponsored transactions per user per day (0 = unlimited)
    uint16 public maxTxPerDay;

    // ============ EVENTS ============

    event GasSponsored(
        address indexed user,
        address indexed relayer,
        uint256 gasAmount,
        uint256 ethAmount
    );

    event RelayerReimbursed(address indexed relayer, uint256 amount);

    event UserWhitelisted(address indexed user, bool whitelisted);
    event RelayerRegistered(address indexed relayer, bool active);
    event ConfigUpdated(SponsorshipConfig config);
    event FundsDeposited(address indexed depositor, uint256 amount);
    event FundsWithdrawn(address indexed to, uint256 amount);
    event SponsorKeyUpdated();
    event KeyRedeemed(address indexed user);

    // ============ ERRORS ============

    error InsufficientFunds();
    error UserNotWhitelisted();
    error DailyQuotaExceeded();
    error DailyTxLimitExceeded();
    error GasLimitExceeded();
    error InvalidRelayer();
    error SponsorshipNotActive();
    error InvalidConfiguration();
    error UnauthorizedCaller();
    error InvalidSponsorKey();
    error AlreadyWhitelisted();

    // ============ CONSTRUCTOR ============

    constructor(address _batchExecutor) Ownable(msg.sender) {
        batchExecutor = _batchExecutor;

        // Default configuration
        config = SponsorshipConfig({
            isActive: true,
            maxGasPerTx: 500000, // 500k gas max per tx
            maxGasPerDay: 2000000, // 2M gas per day per user
            sponsorshipPercent: 100, // Full sponsorship by default
            minBalance: 0.01 ether // Minimum 0.01 ETH to continue
        });

        maxTxPerDay = 10; // Default: 10 sponsored txs per user per day
    }

    // ============ EXTERNAL FUNCTIONS ============

    /**
     * @notice Request gas sponsorship for a user's transaction
     * @dev Called by relayer before executing a meta-transaction
     * @param user The user to sponsor
     * @param gasAmount The amount of gas to sponsor
     * @return sponsoredAmount The actual amount that will be sponsored
     */
    function requestSponsorship(
        address user,
        uint256 gasAmount
    ) external nonReentrant returns (uint256 sponsoredAmount) {
        if (!config.isActive) revert SponsorshipNotActive();
        if (address(this).balance < config.minBalance)
            revert InsufficientFunds();

        // Check relayer
        if (!relayers[msg.sender].isActive) revert InvalidRelayer();

        // Check whitelist if enabled
        if (whitelistOnly && !userQuotas[user].isWhitelisted) {
            revert UserNotWhitelisted();
        }

        // Reset daily quota if needed
        _resetDailyQuotaIfNeeded(user);

        // Check daily limit
        UserQuota storage quota = userQuotas[user];
        uint256 remainingDaily = config.maxGasPerDay > quota.dailyUsed
            ? config.maxGasPerDay - quota.dailyUsed
            : 0;

        if (remainingDaily == 0) revert DailyQuotaExceeded();

        // Check transaction count limit
        if (maxTxPerDay > 0 && quota.dailyTxCount >= maxTxPerDay) {
            revert DailyTxLimitExceeded();
        }

        // Calculate sponsored amount
        uint256 maxSponsorable = _min(gasAmount, config.maxGasPerTx);
        maxSponsorable = _min(maxSponsorable, remainingDaily);

        sponsoredAmount = (maxSponsorable * config.sponsorshipPercent) / 100;

        // Update quotas
        quota.dailyUsed += uint128(sponsoredAmount);
        quota.totalSponsored += uint128(sponsoredAmount);
        quota.dailyTxCount += 1;

        // Update relayer
        relayers[msg.sender].totalGasSponsored += sponsoredAmount;

        // Track total
        totalGasSponsored += sponsoredAmount;

        return sponsoredAmount;
    }

    /**
     * @notice Reimburse a relayer for gas spent
     * @dev Called after successful transaction execution
     * @param relayer The relayer to reimburse
     * @param gasUsed Actual gas used
     * @param gasPrice Gas price used
     */
    function reimburseRelayer(
        address relayer,
        uint256 gasUsed,
        uint256 gasPrice
    ) external nonReentrant {
        if (msg.sender != batchExecutor && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        if (!relayers[relayer].isActive) revert InvalidRelayer();

        uint256 reimbursement = gasUsed * gasPrice;
        uint256 sponsoredReimbursement = (reimbursement *
            config.sponsorshipPercent) / 100;

        if (address(this).balance < sponsoredReimbursement) {
            revert InsufficientFunds();
        }

        totalEthSpent += sponsoredReimbursement;

        (bool success, ) = payable(relayer).call{value: sponsoredReimbursement}(
            ""
        );
        require(success, "Reimbursement failed");

        emit RelayerReimbursed(relayer, sponsoredReimbursement);
    }

    /**
     * @notice Check if a user is eligible for sponsorship
     * @param user The user to check
     * @param gasAmount The amount of gas needed
     * @return eligible Whether the user is eligible
     * @return sponsorableAmount The amount that can be sponsored
     */
    function checkEligibility(
        address user,
        uint256 gasAmount
    ) external view returns (bool eligible, uint256 sponsorableAmount) {
        if (!config.isActive) return (false, 0);
        if (address(this).balance < config.minBalance) return (false, 0);
        if (whitelistOnly && !userQuotas[user].isWhitelisted) return (false, 0);

        UserQuota memory quota = userQuotas[user];

        // Calculate remaining daily quota (considering reset)
        uint256 dailyUsed = quota.dailyUsed;
        uint16 txCount = quota.dailyTxCount;
        if (block.timestamp >= quota.lastResetTime + 1 days) {
            dailyUsed = 0;
            txCount = 0;
        }

        // Check tx count limit
        if (maxTxPerDay > 0 && txCount >= maxTxPerDay) return (false, 0);

        uint256 remainingDaily = config.maxGasPerDay > dailyUsed
            ? config.maxGasPerDay - dailyUsed
            : 0;

        if (remainingDaily == 0) return (false, 0);

        sponsorableAmount = _min(gasAmount, config.maxGasPerTx);
        sponsorableAmount = _min(sponsorableAmount, remainingDaily);
        sponsorableAmount =
            (sponsorableAmount * config.sponsorshipPercent) /
            100;

        return (sponsorableAmount > 0, sponsorableAmount);
    }

    /**
     * @notice Get user's current quota status
     * @param user The user to query
     * @return totalSponsored Total gas ever sponsored
     * @return dailyRemaining Remaining daily quota
     * @return isWhitelisted Whether user is whitelisted
     * @return dailyTxRemaining Number of sponsored txs remaining today
     */
    function getUserQuotaStatus(
        address user
    )
        external
        view
        returns (
            uint256 totalSponsored,
            uint256 dailyRemaining,
            bool isWhitelisted,
            uint256 dailyTxRemaining
        )
    {
        UserQuota memory quota = userQuotas[user];

        uint256 dailyUsed = quota.dailyUsed;
        uint16 txCount = quota.dailyTxCount;
        if (block.timestamp >= quota.lastResetTime + 1 days) {
            dailyUsed = 0;
            txCount = 0;
        }

        dailyRemaining = config.maxGasPerDay > dailyUsed
            ? config.maxGasPerDay - dailyUsed
            : 0;

        dailyTxRemaining = maxTxPerDay > 0 && txCount < maxTxPerDay
            ? uint256(maxTxPerDay - txCount)
            : (maxTxPerDay == 0 ? type(uint256).max : 0);

        return (
            quota.totalSponsored,
            dailyRemaining,
            quota.isWhitelisted,
            dailyTxRemaining
        );
    }

    // ============ ADMIN FUNCTIONS ============

    /**
     * @notice Update sponsorship configuration
     * @param _config New configuration
     */
    function updateConfig(
        SponsorshipConfig calldata _config
    ) external onlyOwner {
        if (_config.sponsorshipPercent > 100) revert InvalidConfiguration();
        config = _config;
        emit ConfigUpdated(_config);
    }

    /**
     * @notice Register or deactivate a relayer
     * @param relayer Relayer address
     * @param active Whether to activate or deactivate
     */
    function setRelayer(address relayer, bool active) external onlyOwner {
        relayers[relayer].isActive = active;
        emit RelayerRegistered(relayer, active);
    }

    /**
     * @notice Whitelist or remove users
     * @param users Array of user addresses
     * @param whitelisted Whether to whitelist or remove
     */
    function setWhitelistedUsers(
        address[] calldata users,
        bool whitelisted
    ) external onlyOwner {
        uint256 len = users.length;
        for (uint256 i = 0; i < len; ) {
            userQuotas[users[i]].isWhitelisted = whitelisted;
            emit UserWhitelisted(users[i], whitelisted);
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Toggle whitelist-only mode
     * @param enabled Whether to enable whitelist mode
     */
    function setWhitelistOnly(bool enabled) external onlyOwner {
        whitelistOnly = enabled;
    }

    /**
     * @notice Set the sponsor key (stored as keccak256 hash)
     * @param key The plaintext key that users will redeem
     */
    function setSponsorKey(string calldata key) external onlyOwner {
        sponsorKeyHash = keccak256(abi.encodePacked(key));
        emit SponsorKeyUpdated();
    }

    /**
     * @notice Set the maximum sponsored transactions per user per day
     * @param _maxTxPerDay Max tx count (0 = unlimited)
     */
    function setMaxTxPerDay(uint16 _maxTxPerDay) external onlyOwner {
        maxTxPerDay = _maxTxPerDay;
    }

    /**
     * @notice Redeem a sponsor key to self-whitelist for gasless transactions
     * @param key The plaintext sponsor key
     */
    function redeemKey(string calldata key) external {
        if (sponsorKeyHash == bytes32(0)) revert InvalidSponsorKey();
        if (keccak256(abi.encodePacked(key)) != sponsorKeyHash) {
            revert InvalidSponsorKey();
        }
        if (userQuotas[msg.sender].isWhitelisted) revert AlreadyWhitelisted();

        userQuotas[msg.sender].isWhitelisted = true;
        emit KeyRedeemed(msg.sender);
        emit UserWhitelisted(msg.sender, true);
    }

    /**
     * @notice Deposit funds for sponsorship
     */
    function deposit() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }

    /**
     * @notice Withdraw funds from sponsor
     * @param to Address to send funds to
     * @param amount Amount to withdraw
     */
    function withdraw(address to, uint256 amount) external onlyOwner {
        if (address(this).balance < amount) revert InsufficientFunds();
        payable(to).transfer(amount);
        emit FundsWithdrawn(to, amount);
    }

    /**
     * @notice Update the batch executor address
     * @param _batchExecutor New batch executor address
     */
    function setBatchExecutor(address _batchExecutor) external onlyOwner {
        batchExecutor = _batchExecutor;
    }

    // ============ VIEW FUNCTIONS ============

    /**
     * @notice Get sponsor statistics
     */
    function getStats()
        external
        view
        returns (
            uint256 balance,
            uint256 _totalGasSponsored,
            uint256 _totalEthSpent,
            bool isActive
        )
    {
        return (
            address(this).balance,
            totalGasSponsored,
            totalEthSpent,
            config.isActive
        );
    }

    // ============ INTERNAL FUNCTIONS ============

    /**
     * @dev Reset daily quota if 24 hours have passed
     */
    function _resetDailyQuotaIfNeeded(address user) internal {
        UserQuota storage quota = userQuotas[user];
        if (block.timestamp >= quota.lastResetTime + 1 days) {
            quota.dailyUsed = 0;
            quota.dailyTxCount = 0;
            quota.lastResetTime = uint48(block.timestamp);
        }
    }

    /**
     * @dev Return minimum of two values
     */
    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // Allow contract to receive ETH
    receive() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }
}
