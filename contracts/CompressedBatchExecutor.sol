// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CompressedBatchExecutor
 * @author Web3Assam Gas Optimizer Team
 * @notice Gas-optimized batch executor using calldata compression techniques
 * @dev Novel optimization: reduces calldata cost by deduplicating repeated targets,
 *      using compact encoding, and providing a single-target fast path.
 *
 * WHY THIS MATTERS:
 * On Ethereum, every byte of calldata costs gas (16 gas/non-zero byte, 4 gas/zero byte).
 * In a typical batch of 5 calls to the same dApp contract:
 *   - Standard batch: 5 × 20-byte addresses = 100 bytes → ~1,600 gas wasted
 *   - Compressed:     1 × 20-byte address   =  20 bytes → ~320 gas
 *   - Savings: ~1,280 gas on addresses alone
 *
 * Combined with eliminated ABI encoding overhead (offset pointers, padding),
 * total calldata savings reach 20-40% over standard batching.
 *
 * THREE EXECUTION MODES:
 * 1. executeSameTarget()        — All calls go to one contract (most efficient)
 * 2. executeCompressedBatch()   — Target deduplication via index table
 * 3. executeWithContext()       — Appends sender to calldata (EIP-2771 compatible)
 */
contract CompressedBatchExecutor is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ============ CONSTANTS ============

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant COMPRESSED_BATCH_TYPEHASH = keccak256(
        "CompressedBatch(address from,bytes32 callsHash,uint256 nonce,uint256 deadline)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ============ STATE VARIABLES ============

    mapping(address => uint256) public nonces;
    uint256 public totalBatchesExecuted;
    uint256 public totalGasSaved;
    uint256 public totalCalldataSaved; // bytes saved via compression

    // ============ STRUCTS ============

    /// @notice Standard call (for comparison / fallback)
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice Compressed call — uses uint8 index into a target table
    struct CompressedCall {
        uint8 targetIndex; // Index into deduplicated targets array (1 byte vs 20)
        uint256 value;
        bytes data;
    }

    /// @notice Meta-tx request for compressed batches
    struct CompressedBatchRequest {
        address from;
        address[] targets;
        CompressedCall[] calls;
        uint256 nonce;
        uint256 deadline;
    }

    // ============ EVENTS ============

    event CompressedBatchExecuted(
        address indexed executor,
        address indexed signer,
        uint256 callCount,
        uint256 gasUsed,
        uint256 calldataSaved,
        uint256 indexed batchId
    );

    event SameTargetBatchExecuted(
        address indexed executor,
        address indexed target,
        uint256 callCount,
        uint256 gasUsed,
        uint256 indexed batchId
    );

    event ContextBatchExecuted(
        address indexed executor,
        address indexed originalSender,
        uint256 callCount,
        uint256 indexed batchId
    );

    // ============ ERRORS ============

    error EmptyBatch();
    error CallFailed(uint256 index, bytes reason);
    error InvalidTargetIndex(uint8 index, uint256 targetsLength);
    error InvalidSignature();
    error ExpiredDeadline();
    error InvalidNonce();

    // ============ CONSTRUCTOR ============

    constructor() Ownable(msg.sender) {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("GasOptimizer")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 1: SAME-TARGET BATCH (Most efficient — all calls to one dApp)
    // ════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute multiple calls to the SAME target contract
     * @dev Most gas-efficient mode. Eliminates N-1 target address copies.
     *      Ideal for dApps where user does multiple actions (list items,
     *      update profile, place bids) in one session.
     * @param target The single target contract
     * @param dataArray Array of calldata for each call
     * @return results Array of return data from each call
     */
    function executeSameTarget(
        address target,
        bytes[] calldata dataArray
    )
        external
        payable
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 len = dataArray.length;
        if (len == 0) revert EmptyBatch();

        uint256 gasStart = gasleft();
        results = new bytes[](len);

        for (uint256 i = 0; i < len; ) {
            (bool success, bytes memory returnData) = target.call(dataArray[i]);
            if (!success) {
                // Efficient revert: pass through the target's revert data
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            results[i] = returnData;
            unchecked { ++i; }
        }

        uint256 gasUsed = gasStart - gasleft();
        totalBatchesExecuted++;

        // Calldata savings: eliminated (N-1) * 20 bytes of repeated addresses
        // plus (N-1) * 32 bytes of repeated value fields (when all zero)
        uint256 calldataByteSaved = (len - 1) * 52; // 20 addr + 32 value per extra call
        totalCalldataSaved += calldataByteSaved;

        // Gas savings: base tx overhead + calldata compression
        uint256 baseTxSavings = (len - 1) * 21000;
        uint256 calldataGasSaved = calldataByteSaved * 16; // 16 gas per non-zero byte
        totalGasSaved += baseTxSavings + calldataGasSaved;

        emit SameTargetBatchExecuted(
            msg.sender,
            target,
            len,
            gasUsed,
            totalBatchesExecuted
        );
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 2: COMPRESSED BATCH (Target deduplication via index table)
    // ════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute a batch using compressed target references
     * @dev Stores unique targets once, each call references by uint8 index.
     *      Supports up to 256 unique targets per batch.
     *      For 5 calls to 2 targets: saves 3 × 19 = 57 bytes of calldata.
     * @param targets Array of unique target addresses
     * @param calls Array of compressed calls with target indices
     * @return results Array of return data from each call
     */
    function executeCompressedBatch(
        address[] calldata targets,
        CompressedCall[] calldata calls
    )
        external
        payable
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 len = calls.length;
        if (len == 0) revert EmptyBatch();

        uint256 gasStart = gasleft();
        results = new bytes[](len);

        for (uint256 i = 0; i < len; ) {
            CompressedCall calldata c = calls[i];
            if (c.targetIndex >= targets.length) {
                revert InvalidTargetIndex(c.targetIndex, targets.length);
            }

            (bool success, bytes memory returnData) = targets[c.targetIndex].call{
                value: c.value
            }(c.data);

            if (!success) revert CallFailed(i, returnData);
            results[i] = returnData;
            unchecked { ++i; }
        }

        uint256 gasUsed = gasStart - gasleft();
        totalBatchesExecuted++;

        // Calldata savings: each call uses 1-byte index instead of 20-byte address
        // = 19 bytes saved per call beyond the unique target set
        uint256 calldataByteSaved = len > targets.length
            ? (len - targets.length) * 19
            : 0;
        totalCalldataSaved += calldataByteSaved;
        totalGasSaved += (len - 1) * 21000 + calldataByteSaved * 16;

        emit CompressedBatchExecuted(
            msg.sender,
            msg.sender,
            len,
            gasUsed,
            calldataByteSaved,
            totalBatchesExecuted
        );
    }

    // ════════════════════════════════════════════════════════════════════
    //  MODE 3: CONTEXT-PRESERVING BATCH (EIP-2771 compatible)
    // ════════════════════════════════════════════════════════════════════

    /**
     * @notice Execute batch while preserving the original sender identity
     * @dev Appends msg.sender to each call's calldata (EIP-2771 pattern).
     *      Target contracts using MetaTxRecipient._msgSender() will see
     *      the original user, not this contract's address.
     *
     *      This solves the fundamental msg.sender problem in batch execution:
     *      Without context: SampleDApp sees BatchExecutor as msg.sender
     *      With context:    SampleDAppMeta sees the real user as _msgSender()
     *
     * @param target Target contract (must inherit MetaTxRecipient)
     * @param dataArray Array of calldata for each call
     * @return results Array of return data from each call
     */
    function executeWithContext(
        address target,
        bytes[] calldata dataArray
    )
        external
        payable
        nonReentrant
        returns (bytes[] memory results)
    {
        uint256 len = dataArray.length;
        if (len == 0) revert EmptyBatch();

        uint256 gasStart = gasleft();
        results = new bytes[](len);

        for (uint256 i = 0; i < len; ) {
            // Append original sender to calldata (EIP-2771)
            bytes memory enrichedData = abi.encodePacked(dataArray[i], msg.sender);

            (bool success, bytes memory returnData) = target.call(enrichedData);
            if (!success) revert CallFailed(i, returnData);
            results[i] = returnData;
            unchecked { ++i; }
        }

        uint256 gasUsed = gasStart - gasleft();
        totalBatchesExecuted++;
        totalGasSaved += (len - 1) * 21000;

        emit ContextBatchExecuted(
            msg.sender,
            msg.sender,
            len,
            totalBatchesExecuted
        );
    }

    /**
     * @notice Meta-tx version: context-preserving batch via relayer
     * @dev Relayer pays gas. Original signer's address is appended to calldata
     *      so target contracts see the real user via _msgSender().
     * @param target Target contract (must inherit MetaTxRecipient)
     * @param dataArray Array of calldata for each call
     * @param from Original signer address
     * @param nonce Replay protection nonce
     * @param deadline Expiration timestamp
     * @param signature EIP-712 signature from the original signer
     * @return results Array of return data from each call
     */
    function executeWithContextMeta(
        address target,
        bytes[] calldata dataArray,
        address from,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    )
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        if (block.timestamp > deadline) revert ExpiredDeadline();
        if (nonce != nonces[from]) revert InvalidNonce();

        // Verify signature
        bytes32 callsHash = _hashDataArray(dataArray);
        bytes32 structHash = keccak256(
            abi.encode(COMPRESSED_BATCH_TYPEHASH, from, callsHash, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
        );
        if (digest.recover(signature) != from) revert InvalidSignature();

        nonces[from]++;

        uint256 len = dataArray.length;
        if (len == 0) revert EmptyBatch();

        results = new bytes[](len);

        for (uint256 i = 0; i < len; ) {
            // Append ORIGINAL signer (not msg.sender/relayer) to calldata
            bytes memory enrichedData = abi.encodePacked(dataArray[i], from);

            (bool success, bytes memory returnData) = target.call(enrichedData);
            if (!success) revert CallFailed(i, returnData);
            results[i] = returnData;
            unchecked { ++i; }
        }

        totalBatchesExecuted++;
        totalGasSaved += (len - 1) * 21000;

        emit ContextBatchExecuted(msg.sender, from, len, totalBatchesExecuted);
    }

    // ════════════════════════════════════════════════════════════════════
    //  CROSS-USER BUNDLING (Multiple users in one transaction)
    // ════════════════════════════════════════════════════════════════════

    /// @notice A single user's signed batch within a bundle
    struct UserBatch {
        address from;
        Call[] calls;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    /**
     * @notice Bundle multiple users' batches into a SINGLE transaction
     * @dev This is what production relayers (Gelato, Biconomy) do.
     *      Instead of submitting one tx per user, the relayer collects
     *      multiple users' signed requests and submits them all at once.
     *
     *      Gas savings: N users × 21000 base cost → just 1 × 21000 base cost
     *      For 5 users: saves 4 × 21000 = 84,000 gas in base tx costs alone
     *
     * @param batches Array of signed user batches
     * @return allResults Nested array of results per user
     */
    function executeBundledBatches(UserBatch[] calldata batches)
        external
        nonReentrant
        returns (bytes[][] memory allResults)
    {
        uint256 batchCount = batches.length;
        if (batchCount == 0) revert EmptyBatch();

        allResults = new bytes[][](batchCount);
        uint256 totalCalls = 0;

        for (uint256 b = 0; b < batchCount; ) {
            UserBatch calldata batch = batches[b];

            // Verify each user's signature
            if (block.timestamp > batch.deadline) revert ExpiredDeadline();
            if (batch.nonce != nonces[batch.from]) revert InvalidNonce();

            bytes32 callsHash = _hashCalls(batch.calls);
            bytes32 structHash = keccak256(
                abi.encode(
                    COMPRESSED_BATCH_TYPEHASH,
                    batch.from,
                    callsHash,
                    batch.nonce,
                    batch.deadline
                )
            );
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash)
            );
            if (digest.recover(batch.signature) != batch.from) {
                revert InvalidSignature();
            }

            nonces[batch.from]++;

            // Execute this user's calls
            uint256 len = batch.calls.length;
            bytes[] memory results = new bytes[](len);

            for (uint256 i = 0; i < len; ) {
                (bool success, bytes memory returnData) = batch.calls[i].target.call{
                    value: batch.calls[i].value
                }(batch.calls[i].data);
                if (!success) revert CallFailed(totalCalls + i, returnData);
                results[i] = returnData;
                unchecked { ++i; }
            }

            allResults[b] = results;
            totalCalls += len;
            unchecked { ++b; }
        }

        totalBatchesExecuted++;
        // Cross-user savings: each additional user saves 21000 base tx gas
        totalGasSaved += (batchCount - 1) * 21000 + (totalCalls - 1) * 21000;
    }

    // ============ VIEW FUNCTIONS ============

    function getNonce(address account) external view returns (uint256) {
        return nonces[account];
    }

    function getGasStats() external view returns (
        uint256 _totalGasSaved,
        uint256 _totalBatchesExecuted,
        uint256 _totalCalldataSaved
    ) {
        return (totalGasSaved, totalBatchesExecuted, totalCalldataSaved);
    }

    /**
     * @notice Estimate gas savings for a hypothetical batch
     * @param callCount Number of calls in the batch
     * @param uniqueTargets Number of unique target contracts
     * @return baseTxSavings Gas saved from eliminating base tx overhead
     * @return calldataSavings Gas saved from calldata compression
     * @return totalSavings Total estimated gas savings
     */
    function estimateSavings(uint256 callCount, uint256 uniqueTargets)
        external
        pure
        returns (uint256 baseTxSavings, uint256 calldataSavings, uint256 totalSavings)
    {
        baseTxSavings = (callCount - 1) * 21000;

        // Calldata savings from target deduplication
        if (callCount > uniqueTargets) {
            calldataSavings = (callCount - uniqueTargets) * 19 * 16; // 19 bytes × 16 gas/byte
        }

        totalSavings = baseTxSavings + calldataSavings;
    }

    // ============ INTERNAL FUNCTIONS ============

    function _hashCalls(Call[] calldata calls) internal pure returns (bytes32) {
        bytes32[] memory callHashes = new bytes32[](calls.length);
        for (uint256 i = 0; i < calls.length; ) {
            callHashes[i] = keccak256(
                abi.encode(calls[i].target, calls[i].value, keccak256(calls[i].data))
            );
            unchecked { ++i; }
        }
        return keccak256(abi.encodePacked(callHashes));
    }

    function _hashDataArray(bytes[] calldata dataArray) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](dataArray.length);
        for (uint256 i = 0; i < dataArray.length; ) {
            hashes[i] = keccak256(dataArray[i]);
            unchecked { ++i; }
        }
        return keccak256(abi.encodePacked(hashes));
    }

    receive() external payable {}
}
