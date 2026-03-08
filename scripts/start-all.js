const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

// Colors for terminal output
const colors = {
    node: '\x1b[36m[NODE]\x1b[0m',
    deploy: '\x1b[33m[DEPLOY]\x1b[0m',
    frontend: '\x1b[35m[FRONTEND]\x1b[0m',
    system: '\x1b[32m[START-ALL]\x1b[0m'
};

function log(tag, msg) {
    console.log(`${tag} ${msg}`);
}

function spawnProcess(command, args, label) {
    const proc = spawn(command, args, {
        cwd: ROOT,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '--no-node-snapshot' }
    });

    proc.stdout.on('data', (data) => {
        data.toString().split('\n').filter(l => l.trim()).forEach(line => {
            log(label, line);
        });
    });

    proc.stderr.on('data', (data) => {
        data.toString().split('\n').filter(l => l.trim()).forEach(line => {
            log(label, line);
        });
    });

    return proc;
}

async function waitForNode(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request({
                    hostname: '127.0.0.1', port: 8545, method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }, (res) => {
                    res.on('data', () => { });
                    res.on('end', resolve);
                });
                req.on('error', reject);
                req.write(JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }));
                req.end();
            });
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return false;
}

async function main() {
    console.log('\n==============================================');
    console.log('  ⛽ Gas Fee Optimizer - Starting All Services');
    console.log('==============================================\n');

    // Step 1: Start Hardhat node
    log(colors.system, 'Starting Hardhat node...');
    const nodeProc = spawnProcess('npx', ['hardhat', 'node'], colors.node);

    // Step 2: Wait for node to be ready
    log(colors.system, 'Waiting for Hardhat node to be ready...');
    const nodeReady = await waitForNode();
    if (!nodeReady) {
        log(colors.system, '❌ Hardhat node failed to start. Exiting.');
        process.exit(1);
    }
    log(colors.system, '✅ Hardhat node is ready!');

    // Step 3: Deploy contracts
    log(colors.system, 'Deploying contracts...');
    await new Promise((resolve, reject) => {
        const deployProc = spawnProcess('npx', ['hardhat', 'run', 'scripts/deploy.js', '--network', 'localhost'], colors.deploy);
        deployProc.on('close', (code) => {
            if (code === 0) {
                log(colors.system, '✅ Contracts deployed successfully!');
                resolve();
            } else {
                log(colors.system, '❌ Contract deployment failed.');
                reject(new Error('Deploy failed'));
            }
        });
    });

    // Step 4: Start frontend server
    log(colors.system, 'Starting frontend server...');
    const frontendProc = spawnProcess('node', ['frontend/serve.js'], colors.frontend);

    console.log('\n==============================================');
    console.log('  ✅ All services are running!');
    console.log('  🌐 Frontend: http://localhost:8080');
    console.log('  ⛓️  Hardhat:  http://127.0.0.1:8545');
    console.log('  📋 Contract addresses auto-loaded in frontend');
    console.log('  Press Ctrl+C to stop all services');
    console.log('==============================================\n');

    // Cleanup on exit
    process.on('SIGINT', () => {
        log(colors.system, '\nShutting down...');
        nodeProc.kill();
        frontendProc.kill();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        nodeProc.kill();
        frontendProc.kill();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
