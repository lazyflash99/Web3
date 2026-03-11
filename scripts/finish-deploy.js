const fs = require('fs');
const path = require('path');

const deploymentInfo = {
  network: 'sepolia',
  chainId: '11155111',
  contracts: {
    BatchExecutor: '0x2c61E8959b5602C1DD9399fB16ABE9182fc7E3E7',
    CompressedBatchExecutor: '0x01eAA34feF31F33E5EB15C5084569C1399B9C0CB',
    GasSponsor: '0x856371cEED89a9c14E038e9cd3BF7026B004C663',
    Forwarder: '0x21a94492478f4A00d29774c3754Ca8aB24FB8c9f',
    GaslessToken: '0x66Eb4Fe980a960FC04553591c156e5DeDb9d7809',
    SampleDApp: '0x47FF1aCB49cf23C28AA5887FC3bb5073D566f938',
    SampleDAppMeta: '0xAE3329Cec2A4827dd13E9b86874CF175179B0E54'
  },
  deployer: '0x54fD54384Fa4A1CFc39Dc2931CB3CECD2F4Dd7EA'
};

// Save deployment info
fs.writeFileSync(path.join(__dirname, '..', 'deployments', 'sepolia.json'), JSON.stringify(deploymentInfo, null, 2));
console.log('Saved deployments/sepolia.json');

// Generate hosted frontend
const frontendSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf-8');
const hosted = frontendSrc.replace(
  /const DEPLOYED = \{[^}]*\};/s,
  `const DEPLOYED = {
                BatchExecutor: "0x2c61E8959b5602C1DD9399fB16ABE9182fc7E3E7",
                CompressedBatchExecutor: "0x01eAA34feF31F33E5EB15C5084569C1399B9C0CB",
                SampleDApp: "0x47FF1aCB49cf23C28AA5887FC3bb5073D566f938",
            };`
);

const hostedDir = path.join(__dirname, '..', 'hosted');
if (!fs.existsSync(hostedDir)) fs.mkdirSync(hostedDir);
fs.writeFileSync(path.join(hostedDir, 'index.html'), hosted);
console.log('Generated hosted/index.html');

console.log('\nEtherscan links:');
const base = 'https://sepolia.etherscan.io';
for (const [name, addr] of Object.entries(deploymentInfo.contracts)) {
  console.log(`  ${name}: ${base}/address/${addr}`);
}

console.log('\nFrontend URL params:');
console.log('  ?batch=0x2c61E8959b5602C1DD9399fB16ABE9182fc7E3E7&compressed=0x01eAA34feF31F33E5EB15C5084569C1399B9C0CB&dapp=0x47FF1aCB49cf23C28AA5887FC3bb5073D566f938');
