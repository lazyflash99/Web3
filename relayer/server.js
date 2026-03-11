/**
 * Gas Optimizer Relayer Service
 * 
 * A standalone Node.js service that:
 * 1. Receives signed meta-transactions from users
 * 2. Validates the signatures
 * 3. Submits transactions on behalf of users
 * 4. Manages gas pricing and nonce handling
 * 5. Provides gas sponsorship based on policies
 * 
 * Architecture:
 * ┌─────────┐     ┌─────────────┐     ┌─────────────┐
 * │  User   │────>│   Relayer   │────>│  Blockchain │
 * │ (signs) │     │  (submits)  │     │  (executes) │
 * └─────────┘     └─────────────┘     └─────────────┘
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//                            CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const config = {
    // Server settings
    port: process.env.PORT || 3000,
    
    // Blockchain settings
    rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8545',
    chainId: process.env.CHAIN_ID || 31337,
    
    // Relayer wallet (must have ETH for gas)
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY || 
        '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // Hardhat Account #1 (well-known test key)
    
    // Contracts (deploy first, then update these)
    batchExecutorAddress: process.env.BATCH_EXECUTOR || '',
    compressedBatchExecutorAddress: process.env.COMPRESSED_BATCH_EXECUTOR || '',
    forwarderAddress: process.env.FORWARDER || '',
    gasSponsorAddress: process.env.GAS_SPONSOR || '',
    
    // Rate limiting
    maxRequestsPerMinute: 10,
    maxGasPerRequest: 2000000,
    
    // Cross-user bundling
    bundling: {
        enabled: true,
        maxQueueSize: 20,
        flushIntervalMs: 5000,  // Flush every 5 seconds
        minBatchSize: 2,        // Minimum requests before auto-flush
    },
    
    // Sponsorship policies
    sponsorship: {
        enabled: true,
        maxGasPerUser: 1000000, // Per day
        whitelistedContracts: [], // Empty = all allowed
    }
};

// ═══════════════════════════════════════════════════════════════════════════
//                            INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const app = express();
app.use(cors());
app.use(express.json());

// Provider and wallet
let provider;
let relayerWallet;
let batchExecutor;
let compressedBatchExecutor;
let forwarder;
let gasSponsor;

// Rate limiting storage (in-memory, use Redis in production)
const rateLimits = new Map();
const dailyUsage = new Map();

// Cross-user bundle queue
const bundleQueue = [];
let flushTimer = null;

// Contract ABIs (simplified - in production, load from artifacts)
const BATCH_EXECUTOR_ABI = [
    "function executeBatchMeta((address from, (address target, uint256 value, bytes data)[] calls, uint256 nonce, uint256 deadline) request, bytes signature) returns (bytes[] results)",
    "function getNonce(address account) view returns (uint256)",
    "function authorizedRelayers(address) view returns (bool)"
];

const FORWARDER_ABI = [
    "function execute((address from, address to, uint256 value, uint256 gas, uint256 nonce, bytes data) req, bytes signature) payable returns (bool success, bytes returndata)",
    "function getNonce(address from) view returns (uint256)"
];

const GAS_SPONSOR_ABI = [
    "function checkEligibility(address user, uint256 requestedGas) view returns (bool eligible, uint256 sponsoredAmount)",
    "function config() view returns (bool isActive, uint256 maxGasPerTx, uint256 maxGasPerDay, uint256 sponsorshipPercent, uint256 minBalance)"
];

const COMPRESSED_BATCH_EXECUTOR_ABI = [
    "function executeSameTarget(address target, bytes[] calldata dataArray) external payable returns (bytes[] memory)",
    "function executeCompressedBatch(address[] calldata targets, (uint8 targetIndex, uint256 value, bytes data)[] calldata calls) external payable returns (bytes[] memory)",
    "function executeWithContext(address target, bytes[] calldata dataArray) external payable returns (bytes[] memory)",
    "function executeWithContextMeta(address target, bytes[] calldata dataArray, address originalSender, bytes calldata signature) external payable returns (bytes[] memory)",
    "function executeBundledBatches((address user, address target, bytes[] calls)[] calldata batches) external payable returns (bytes[][] memory)",
    "function estimateSavings(uint256 numCalls, uint256 numUniqueTargets) external pure returns (uint256 calldataSaved, uint256 approxGasSaved)"
];

// ═══════════════════════════════════════════════════════════════════════════
//                            INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

async function initialize() {
    console.log('🚀 Initializing Relayer Service...\n');
    
    // Connect to blockchain
    provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const network = await provider.getNetwork();
    console.log(`📡 Connected to network: ${network.name} (chainId: ${network.chainId})`);
    
    // Initialize wallet
    relayerWallet = new ethers.Wallet(config.relayerPrivateKey, provider);
    const balance = await provider.getBalance(relayerWallet.address);
    console.log(`💰 Relayer address: ${relayerWallet.address}`);
    console.log(`💰 Relayer balance: ${ethers.formatEther(balance)} ETH\n`);
    
    // Initialize contracts if addresses provided
    if (config.batchExecutorAddress) {
        batchExecutor = new ethers.Contract(
            config.batchExecutorAddress,
            BATCH_EXECUTOR_ABI,
            relayerWallet
        );
        console.log(`📋 BatchExecutor: ${config.batchExecutorAddress}`);
    }
    
    if (config.forwarderAddress) {
        forwarder = new ethers.Contract(
            config.forwarderAddress,
            FORWARDER_ABI,
            relayerWallet
        );
        console.log(`📋 Forwarder: ${config.forwarderAddress}`);
    }
    
    if (config.gasSponsorAddress) {
        gasSponsor = new ethers.Contract(
            config.gasSponsorAddress,
            GAS_SPONSOR_ABI,
            relayerWallet
        );
        console.log(`📋 GasSponsor: ${config.gasSponsorAddress}`);
    }
    
    if (config.compressedBatchExecutorAddress) {
        compressedBatchExecutor = new ethers.Contract(
            config.compressedBatchExecutorAddress,
            COMPRESSED_BATCH_EXECUTOR_ABI,
            relayerWallet
        );
        console.log(`📋 CompressedBatchExecutor: ${config.compressedBatchExecutorAddress}`);
    }
    
    // Start bundle flush timer
    if (config.bundling.enabled) {
        flushTimer = setInterval(flushBundleQueue, config.bundling.flushIntervalMs);
        console.log(`📦 Cross-user bundling enabled (flush every ${config.bundling.flushIntervalMs}ms)`);
    }
    
    console.log('\n✅ Initialization complete!\n');
}

// ═══════════════════════════════════════════════════════════════════════════
//                            MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

// Rate limiting middleware
function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    
    if (!rateLimits.has(ip)) {
        rateLimits.set(ip, { count: 1, resetTime: now + windowMs });
        return next();
    }
    
    const limit = rateLimits.get(ip);
    
    if (now > limit.resetTime) {
        limit.count = 1;
        limit.resetTime = now + windowMs;
        return next();
    }
    
    if (limit.count >= config.maxRequestsPerMinute) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil((limit.resetTime - now) / 1000)
        });
    }
    
    limit.count++;
    next();
}

// Request validation middleware
function validateRequest(req, res, next) {
    const { from, signature } = req.body;
    
    if (!from || !ethers.isAddress(from)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid or missing "from" address'
        });
    }
    
    if (!signature || !signature.startsWith('0x')) {
        return res.status(400).json({
            success: false,
            error: 'Invalid or missing signature'
        });
    }
    
    next();
}

// ═══════════════════════════════════════════════════════════════════════════
//                              ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        relayer: relayerWallet?.address,
        contracts: {
            batchExecutor: config.batchExecutorAddress || 'not configured',
            forwarder: config.forwarderAddress || 'not configured',
            gasSponsor: config.gasSponsorAddress || 'not configured'
        }
    });
});

// Get relayer status
app.get('/status', async (req, res) => {
    try {
        const balance = await provider.getBalance(relayerWallet.address);
        const nonce = await provider.getTransactionCount(relayerWallet.address);
        
        res.json({
            success: true,
            data: {
                relayerAddress: relayerWallet.address,
                balance: ethers.formatEther(balance),
                nonce,
                chainId: config.chainId,
                sponsorshipEnabled: config.sponsorship.enabled
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get user's current nonce
app.get('/nonce/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid address'
            });
        }
        
        let nonce = 0n;
        
        if (batchExecutor) {
            nonce = await batchExecutor.getNonce(address);
        } else if (forwarder) {
            nonce = await forwarder.getNonce(address);
        }
        
        res.json({
            success: true,
            data: {
                address,
                nonce: nonce.toString()
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Submit batch meta-transaction
app.post('/relay/batch', rateLimit, validateRequest, async (req, res) => {
    try {
        const { from, calls, nonce, deadline, signature } = req.body;
        
        // Validate calls array
        if (!Array.isArray(calls) || calls.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or empty calls array'
            });
        }
        
        // Check contract is initialized
        if (!batchExecutor) {
            return res.status(503).json({
                success: false,
                error: 'BatchExecutor not configured'
            });
        }
        
        // Verify nonce
        const currentNonce = await batchExecutor.getNonce(from);
        if (BigInt(nonce) !== currentNonce) {
            return res.status(400).json({
                success: false,
                error: `Invalid nonce. Expected ${currentNonce}, got ${nonce}`
            });
        }
        
        // Check deadline
        const now = Math.floor(Date.now() / 1000);
        if (deadline && deadline < now) {
            return res.status(400).json({
                success: false,
                error: 'Deadline has passed'
            });
        }
        
        // Check sponsorship eligibility
        if (config.sponsorship.enabled && gasSponsor) {
            const [eligible, sponsoredAmount] = await gasSponsor.checkEligibility(
                from,
                config.maxGasPerRequest
            );
            
            if (!eligible) {
                return res.status(403).json({
                    success: false,
                    error: 'User not eligible for gas sponsorship'
                });
            }
        }
        
        // Prepare the batch request
        const batchRequest = {
            from,
            calls: calls.map(c => ({
                target: c.target,
                value: c.value || 0,
                data: c.data
            })),
            nonce,
            deadline: deadline || now + 3600 // 1 hour default
        };
        
        // Estimate gas
        const gasEstimate = await batchExecutor.executeBatchMeta.estimateGas(
            batchRequest,
            signature
        );
        
        if (gasEstimate > config.maxGasPerRequest) {
            return res.status(400).json({
                success: false,
                error: `Gas estimate ${gasEstimate} exceeds maximum ${config.maxGasPerRequest}`
            });
        }
        
        // Submit transaction
        console.log(`\n📤 Relaying batch for ${from}`);
        console.log(`   Calls: ${calls.length}`);
        console.log(`   Gas estimate: ${gasEstimate}`);
        
        const tx = await batchExecutor.executeBatchMeta(
            batchRequest,
            signature,
            { gasLimit: gasEstimate * 120n / 100n } // 20% buffer
        );
        
        console.log(`   Tx hash: ${tx.hash}`);
        
        // Wait for confirmation
        const receipt = await tx.wait();
        
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed}`);
        
        // Update daily usage tracking
        const key = `${from}-${new Date().toDateString()}`;
        const currentUsage = dailyUsage.get(key) || 0n;
        dailyUsage.set(key, currentUsage + receipt.gasUsed);
        
        res.json({
            success: true,
            data: {
                transactionHash: tx.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                effectiveGasPrice: receipt.gasPrice?.toString()
            }
        });
        
    } catch (error) {
        console.error('❌ Relay error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Submit single meta-transaction via forwarder
app.post('/relay/forward', rateLimit, validateRequest, async (req, res) => {
    try {
        const { from, to, value, gas, nonce, data, signature } = req.body;
        
        // Check contract is initialized
        if (!forwarder) {
            return res.status(503).json({
                success: false,
                error: 'Forwarder not configured'
            });
        }
        
        // Verify nonce
        const currentNonce = await forwarder.getNonce(from);
        if (BigInt(nonce) !== currentNonce) {
            return res.status(400).json({
                success: false,
                error: `Invalid nonce. Expected ${currentNonce}, got ${nonce}`
            });
        }
        
        // Prepare forward request
        const forwardRequest = {
            from,
            to,
            value: value || 0,
            gas: gas || 500000,
            nonce,
            data: data || '0x'
        };
        
        // Submit transaction
        console.log(`\n📤 Forwarding for ${from} -> ${to}`);
        
        const tx = await forwarder.execute(forwardRequest, signature);
        const receipt = await tx.wait();
        
        console.log(`   ✅ Confirmed: ${tx.hash}`);
        
        res.json({
            success: true,
            data: {
                transactionHash: tx.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString()
            }
        });
        
    } catch (error) {
        console.error('❌ Forward error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check gas sponsorship eligibility
app.get('/sponsorship/:address', async (req, res) => {
    try {
        const { address } = req.params;
        
        if (!gasSponsor) {
            return res.json({
                success: true,
                data: {
                    eligible: config.sponsorship.enabled,
                    reason: 'No gas sponsor contract configured'
                }
            });
        }
        
        const [eligible, sponsoredAmount] = await gasSponsor.checkEligibility(
            address,
            config.maxGasPerRequest
        );
        
        const key = `${address}-${new Date().toDateString()}`;
        const usedToday = dailyUsage.get(key) || 0n;
        
        res.json({
            success: true,
            data: {
                eligible,
                maxSponsoredGas: sponsoredAmount.toString(),
                usedToday: usedToday.toString(),
                dailyLimit: config.sponsorship.maxGasPerUser
            }
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get gas price recommendations
app.get('/gas-price', async (req, res) => {
    try {
        const feeData = await provider.getFeeData();
        
        res.json({
            success: true,
            data: {
                gasPrice: feeData.gasPrice?.toString(),
                maxFeePerGas: feeData.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString()
            }
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Configure contracts (for development)
app.post('/config/contracts', async (req, res) => {
    try {
        const { 
            batchExecutor: batchAddr, 
            compressedBatchExecutor: compressedAddr,
            forwarder: forwardAddr, 
            gasSponsor: sponsorAddr 
        } = req.body;
        
        if (batchAddr && ethers.isAddress(batchAddr)) {
            config.batchExecutorAddress = batchAddr;
            batchExecutor = new ethers.Contract(batchAddr, BATCH_EXECUTOR_ABI, relayerWallet);
        }
        
        if (compressedAddr && ethers.isAddress(compressedAddr)) {
            config.compressedBatchExecutorAddress = compressedAddr;
            compressedBatchExecutor = new ethers.Contract(compressedAddr, COMPRESSED_BATCH_EXECUTOR_ABI, relayerWallet);
        }
        
        if (forwardAddr && ethers.isAddress(forwardAddr)) {
            config.forwarderAddress = forwardAddr;
            forwarder = new ethers.Contract(forwardAddr, FORWARDER_ABI, relayerWallet);
        }
        
        if (sponsorAddr && ethers.isAddress(sponsorAddr)) {
            config.gasSponsorAddress = sponsorAddr;
            gasSponsor = new ethers.Contract(sponsorAddr, GAS_SPONSOR_ABI, relayerWallet);
        }
        
        res.json({
            success: true,
            data: {
                batchExecutor: config.batchExecutorAddress,
                compressedBatchExecutor: config.compressedBatchExecutorAddress,
                forwarder: config.forwarderAddress,
                gasSponsor: config.gasSponsorAddress
            }
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//                        CROSS-USER BUNDLING
// ═══════════════════════════════════════════════════════════════════════════

// Flush the bundle queue - submit all queued requests in a single tx
async function flushBundleQueue() {
    if (bundleQueue.length < config.bundling.minBatchSize) return;
    
    const batch = bundleQueue.splice(0, config.bundling.maxQueueSize);
    
    if (!compressedBatchExecutor || batch.length === 0) return;
    
    console.log(`\n📦 Flushing bundle queue: ${batch.length} user batches`);
    
    try {
        // Build UserBatch[] for executeBundledBatches
        const userBatches = batch.map(entry => ({
            user: entry.from,
            target: entry.target,
            calls: entry.calls
        }));
        
        const tx = await compressedBatchExecutor.executeBundledBatches(userBatches);
        const receipt = await tx.wait();
        
        console.log(`   ✅ Bundle confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed} for ${batch.length} users`);
        console.log(`   Gas per user: ~${receipt.gasUsed / BigInt(batch.length)}`);
        
        // Resolve all pending promises
        batch.forEach(entry => {
            entry.resolve({
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                bundledWith: batch.length,
                gasPerUser: (receipt.gasUsed / BigInt(batch.length)).toString()
            });
        });
    } catch (error) {
        console.error('❌ Bundle flush error:', error.message);
        batch.forEach(entry => entry.reject(error));
    }
}

// Submit to cross-user bundle queue (gasless for all users)
app.post('/relay/bundle', rateLimit, async (req, res) => {
    try {
        const { from, target, calls } = req.body;
        
        if (!from || !ethers.isAddress(from)) {
            return res.status(400).json({ success: false, error: 'Invalid "from" address' });
        }
        if (!target || !ethers.isAddress(target)) {
            return res.status(400).json({ success: false, error: 'Invalid "target" address' });
        }
        if (!Array.isArray(calls) || calls.length === 0) {
            return res.status(400).json({ success: false, error: 'Empty calls array' });
        }
        
        if (!compressedBatchExecutor) {
            return res.status(503).json({ success: false, error: 'CompressedBatchExecutor not configured' });
        }
        
        // Add to queue with a promise that resolves when the bundle is flushed
        const resultPromise = new Promise((resolve, reject) => {
            bundleQueue.push({ from, target, calls, resolve, reject });
        });
        
        console.log(`📥 Queued bundle request from ${from} (${calls.length} calls, queue size: ${bundleQueue.length})`);
        
        // Auto-flush if queue is full
        if (bundleQueue.length >= config.bundling.maxQueueSize) {
            flushBundleQueue();
        }
        
        // Wait for the bundle to be submitted
        const result = await resultPromise;
        
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('❌ Bundle error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Force flush the bundle queue immediately
app.post('/relay/bundle/flush', async (req, res) => {
    try {
        const queueSize = bundleQueue.length;
        if (queueSize === 0) {
            return res.json({ success: true, data: { message: 'Queue empty, nothing to flush' } });
        }
        await flushBundleQueue();
        res.json({ success: true, data: { flushed: queueSize } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Submit compressed batch (single user, optimized calldata)
app.post('/relay/compressed', rateLimit, async (req, res) => {
    try {
        const { target, dataArray } = req.body;
        
        if (!target || !ethers.isAddress(target)) {
            return res.status(400).json({ success: false, error: 'Invalid target address' });
        }
        if (!Array.isArray(dataArray) || dataArray.length === 0) {
            return res.status(400).json({ success: false, error: 'Empty dataArray' });
        }
        if (!compressedBatchExecutor) {
            return res.status(503).json({ success: false, error: 'CompressedBatchExecutor not configured' });
        }
        
        const tx = await compressedBatchExecutor.executeSameTarget(target, dataArray);
        const receipt = await tx.wait();
        
        console.log(`📤 Compressed batch: ${dataArray.length} calls to ${target}`);
        console.log(`   Gas used: ${receipt.gasUsed}`);
        
        res.json({
            success: true,
            data: {
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                callCount: dataArray.length
            }
        });
    } catch (error) {
        console.error('❌ Compressed relay error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get gas savings estimate
app.get('/estimate/:numCalls/:numTargets', async (req, res) => {
    try {
        const numCalls = parseInt(req.params.numCalls);
        const numTargets = parseInt(req.params.numTargets);
        
        if (!compressedBatchExecutor) {
            return res.status(503).json({ success: false, error: 'CompressedBatchExecutor not configured' });
        }
        
        const [calldataSaved, approxGasSaved] = await compressedBatchExecutor.estimateSavings(numCalls, numTargets);
        
        res.json({
            success: true,
            data: {
                calldataSaved: calldataSaved.toString(),
                approxGasSaved: approxGasSaved.toString(),
                numCalls,
                numTargets
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//                              START SERVER
// ═══════════════════════════════════════════════════════════════════════════

async function startServer() {
    await initialize();
    
    app.listen(config.port, () => {
        console.log('═══════════════════════════════════════════════════════');
        console.log(`🚀 Relayer Service running on port ${config.port}`);
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('Available endpoints:');
        console.log('  GET  /health              - Health check');
        console.log('  GET  /status              - Relayer status');
        console.log('  GET  /nonce/:address      - Get user nonce');
        console.log('  POST /relay/batch         - Submit batch meta-tx');
        console.log('  POST /relay/forward       - Submit forwarded tx');
        console.log('  POST /relay/compressed    - Submit compressed batch');
        console.log('  POST /relay/bundle        - Queue cross-user bundle');
        console.log('  POST /relay/bundle/flush  - Force flush bundle queue');
        console.log('  GET  /estimate/:n/:t      - Estimate gas savings');
        console.log('  GET  /sponsorship/:addr   - Check sponsorship');
        console.log('  GET  /gas-price           - Get gas prices');
        console.log('  POST /config/contracts    - Configure contracts\n');
    });
}

// Export for testing
module.exports = { app, initialize, config };

// Start if run directly
if (require.main === module) {
    startServer().catch(console.error);
}
