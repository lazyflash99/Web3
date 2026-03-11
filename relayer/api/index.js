const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
//                            CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const config = {
    rpcUrls: [
        process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
        'https://rpc.sepolia.org',
        'https://sepolia.gateway.tenderly.co'
    ],
    chainId: 11155111,
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
    contracts: {
        batchExecutor: '0x2c61E8959b5602C1DD9399fB16ABE9182fc7E3E7',
        compressedBatchExecutor: '0x01eAA34feF31F33E5EB15C5084569C1399B9C0CB',
        forwarder: '0x21a94492478f4A00d29774c3754Ca8aB24FB8c9f',
        gasSponsor: '0x856371cEED89a9c14E038e9cd3BF7026B004C663',
    },
    maxRequestsPerMinute: 10,
    maxGasPerRequest: 2000000,
};

// Rate limiting (in-memory per cold start)
const rateLimits = new Map();

// ABIs
const BATCH_EXECUTOR_ABI = [
    "function executeBatchMeta((address from, (address target, uint256 value, bytes data)[] calls, uint256 nonce, uint256 deadline) request, bytes signature) returns (bytes[] results)",
    "function getNonce(address account) view returns (uint256)",
];

const COMPRESSED_BATCH_EXECUTOR_ABI = [
    "function executeSameTarget(address target, bytes[] calldata dataArray) external payable returns (bytes[] memory)",
    "function executeCompressedBatch(address[] calldata targets, (uint8 targetIndex, uint256 value, bytes data)[] calldata calls) external payable returns (bytes[] memory)",
    "function estimateSavings(uint256 numCalls, uint256 numUniqueTargets) external pure returns (uint256 calldataSaved, uint256 approxGasSaved)",
];

const GAS_SPONSOR_ABI = [
    "function checkEligibility(address user, uint256 requestedGas) view returns (bool eligible, uint256 sponsoredAmount)",
];

// Lazy init
let provider, relayerWallet, batchExecutor, compressedBatchExecutor;
let rpcIndex = 0;

function getProvider() {
    if (!provider) {
        provider = new ethers.JsonRpcProvider(config.rpcUrls[rpcIndex]);
    }
    return provider;
}

function rotateProvider() {
    rpcIndex = (rpcIndex + 1) % config.rpcUrls.length;
    provider = new ethers.JsonRpcProvider(config.rpcUrls[rpcIndex]);
    relayerWallet = null;
    batchExecutor = null;
    compressedBatchExecutor = null;
    return provider;
}

function getWallet() {
    if (!relayerWallet) {
        if (!config.relayerPrivateKey) throw new Error('RELAYER_PRIVATE_KEY not set');
        relayerWallet = new ethers.Wallet(config.relayerPrivateKey, getProvider());
    }
    return relayerWallet;
}

function getBatchExecutor() {
    if (!batchExecutor) batchExecutor = new ethers.Contract(config.contracts.batchExecutor, BATCH_EXECUTOR_ABI, getWallet());
    return batchExecutor;
}

function getCompressedBatchExecutor() {
    if (!compressedBatchExecutor) compressedBatchExecutor = new ethers.Contract(config.contracts.compressedBatchExecutor, COMPRESSED_BATCH_EXECUTOR_ABI, getWallet());
    return compressedBatchExecutor;
}

// Rate limiter
function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60000;
    if (!rateLimits.has(ip)) { rateLimits.set(ip, { count: 1, resetTime: now + windowMs }); return next(); }
    const limit = rateLimits.get(ip);
    if (now > limit.resetTime) { limit.count = 1; limit.resetTime = now + windowMs; return next(); }
    if (limit.count >= config.maxRequestsPerMinute) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }
    limit.count++;
    next();
}

// ═══════════════════════════════════════════════════════════════════════════
//                              ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    try {
        const wallet = getWallet();
        res.json({
            status: 'healthy',
            relayer: wallet.address,
            contracts: config.contracts,
            rpc: config.rpcUrls[rpcIndex],
        });
    } catch (e) {
        res.json({ status: 'healthy', relayer: 'not configured', note: e.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        const wallet = getWallet();
        const balance = await getProvider().getBalance(wallet.address);
        res.json({
            success: true,
            data: {
                relayerAddress: wallet.address,
                balance: ethers.formatEther(balance),
                chainId: config.chainId,
            },
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/nonce/:address', async (req, res) => {
    try {
        const { address } = req.params;
        if (!ethers.isAddress(address)) return res.status(400).json({ success: false, error: 'Invalid address' });
        const nonce = await getBatchExecutor().getNonce(address);
        res.json({ success: true, data: { address, nonce: nonce.toString() } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Relay batch meta-transaction
app.post('/relay/batch', rateLimit, async (req, res) => {
    try {
        const { from, calls, nonce, deadline, signature } = req.body;
        if (!from || !ethers.isAddress(from)) return res.status(400).json({ success: false, error: 'Invalid from address' });
        if (!signature || !signature.startsWith('0x')) return res.status(400).json({ success: false, error: 'Missing signature' });
        if (!Array.isArray(calls) || calls.length === 0) return res.status(400).json({ success: false, error: 'Empty calls' });

        let lastError;
        for (let attempt = 0; attempt < config.rpcUrls.length; attempt++) {
            try {
                const executor = getBatchExecutor();
                const currentNonce = await executor.getNonce(from);
                if (BigInt(nonce) !== currentNonce) {
                    return res.status(400).json({ success: false, error: `Invalid nonce. Expected ${currentNonce}, got ${nonce}` });
                }

                const now = Math.floor(Date.now() / 1000);
                const batchRequest = {
                    from,
                    calls: calls.map(c => ({ target: c.target, value: c.value || 0, data: c.data })),
                    nonce,
                    deadline: deadline || now + 3600,
                };

                const gasEstimate = await executor.executeBatchMeta.estimateGas(batchRequest, signature);
                const tx = await executor.executeBatchMeta(batchRequest, signature, { gasLimit: gasEstimate * 120n / 100n });
                const receipt = await tx.wait();

                return res.json({
                    success: true,
                    data: {
                        transactionHash: tx.hash,
                        blockNumber: receipt.blockNumber,
                        gasUsed: receipt.gasUsed.toString(),
                    },
                });
            } catch (e) {
                lastError = e;
                rotateProvider();
            }
        }
        res.status(500).json({ success: false, error: lastError.message });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Compressed batch relay
app.post('/relay/compressed', rateLimit, async (req, res) => {
    try {
        const { target, dataArray } = req.body;
        if (!target || !ethers.isAddress(target)) return res.status(400).json({ success: false, error: 'Invalid target' });
        if (!Array.isArray(dataArray) || dataArray.length === 0) return res.status(400).json({ success: false, error: 'Empty dataArray' });

        const executor = getCompressedBatchExecutor();
        const tx = await executor.executeSameTarget(target, dataArray);
        const receipt = await tx.wait();

        res.json({
            success: true,
            data: {
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                callCount: dataArray.length,
            },
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Gas savings estimate
app.get('/estimate/:numCalls/:numTargets', async (req, res) => {
    try {
        const numCalls = parseInt(req.params.numCalls);
        const numTargets = parseInt(req.params.numTargets);
        const executor = getCompressedBatchExecutor();
        const [calldataSaved, approxGasSaved] = await executor.estimateSavings(numCalls, numTargets);
        res.json({ success: true, data: { calldataSaved: calldataSaved.toString(), approxGasSaved: approxGasSaved.toString() } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Config endpoint (read-only for deployed version)
app.post('/config/contracts', (req, res) => {
    res.json({ success: true, data: config.contracts });
});

app.get('/gas-price', async (req, res) => {
    try {
        const feeData = await getProvider().getFeeData();
        res.json({
            success: true,
            data: {
                gasPrice: feeData.gasPrice?.toString(),
                maxFeePerGas: feeData.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.toString(),
            },
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = app;
