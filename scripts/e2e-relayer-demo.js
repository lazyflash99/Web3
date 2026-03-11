/**
 * End-to-end test: User signs meta-tx → Relayer submits on-chain
 * This demonstrates the exact flow the organizer described:
 * "frontend constructs batch, collects one signature, forwards to relayer"
 */
const { ethers } = require("hardhat");

async function main() {
  console.log("=== E2E: Gasless Meta-Transaction via Relayer ===\n");

  const [deployer, relayer, user] = await ethers.getSigners();
  
  // Load deployed contracts
  const deployments = require("../deployments/localhost.json");
  const batchExecutor = await ethers.getContractAt("BatchExecutor", deployments.contracts.BatchExecutor);
  const sampleDApp = await ethers.getContractAt("SampleDApp", deployments.contracts.SampleDApp);

  // Check user's initial ETH balance
  const userBalanceBefore = await ethers.provider.getBalance(user.address);
  console.log(`User address: ${user.address}`);
  console.log(`User balance before: ${ethers.formatEther(userBalanceBefore)} ETH`);
  console.log(`Relayer address: ${relayer.address}\n`);

  // ===== STEP 1: User builds the batch (frontend side) =====
  console.log("STEP 1: User builds the batch of calls...");
  const calls = [
    {
      target: deployments.contracts.SampleDApp,
      value: 0,
      data: sampleDApp.interface.encodeFunctionData("updateProfile", ["Alice", "Web3 developer"])
    },
    {
      target: deployments.contracts.SampleDApp,
      value: 0,
      data: sampleDApp.interface.encodeFunctionData("createListing", ["Cool NFT", ethers.parseEther("0.5")])
    }
  ];
  console.log(`   Built ${calls.length} calls\n`);

  // ===== STEP 2: User signs EIP-712 typed data (NO GAS) =====
  console.log("STEP 2: User signs EIP-712 typed data (NO gas required)...");
  const nonce = await batchExecutor.getNonce(user.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const domain = {
    name: "GasOptimizer",
    version: "1",
    chainId: 31337,
    verifyingContract: deployments.contracts.BatchExecutor
  };

  const types = {
    BatchExecution: [
      { name: "from", type: "address" },
      { name: "callsHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" }
    ]
  };

  // Hash calls the same way the contract does in _hashCalls
  const callHashes = calls.map(c => 
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "bytes32"],
        [c.target, c.value, ethers.keccak256(c.data)]
      )
    )
  );
  const callsHash = ethers.keccak256(ethers.solidityPacked(
    callHashes.map(() => "bytes32"),
    callHashes
  ));

  const value = {
    from: user.address,
    callsHash: callsHash,
    nonce: nonce,
    deadline: deadline
  };

  const signature = await user.signTypedData(domain, types, value);
  console.log(`   Signature: ${signature.slice(0, 30)}...\n`);

  // ===== STEP 3: Send to relayer (HTTP POST) =====
  console.log("STEP 3: Forwarding signed payload to relayer at http://localhost:3000...");
  const relayPayload = {
    from: user.address,
    calls: calls.map(c => ({
      target: c.target,
      value: c.value.toString(),
      data: c.data
    })),
    nonce: nonce.toString(),
    deadline: deadline,
    signature: signature
  };

  const response = await fetch("http://localhost:3000/relay/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(relayPayload)
  });

  const result = await response.json();
  
  if (!result.success) {
    console.log(`   Relayer error: ${result.error}`);
    process.exit(1);
  }

  console.log(`   Relayer submitted tx: ${result.data.transactionHash}`);
  console.log(`   Block: ${result.data.blockNumber}`);
  console.log(`   Gas used by relayer: ${result.data.gasUsed}\n`);

  // ===== STEP 4: Verify results =====
  console.log("STEP 4: Verifying results...");
  
  const userBalanceAfter = await ethers.provider.getBalance(user.address);
  const balanceDiff = userBalanceBefore - userBalanceAfter;
  console.log(`   User balance after: ${ethers.formatEther(userBalanceAfter)} ETH`);
  console.log(`   User spent: ${ethers.formatEther(balanceDiff)} ETH`);
  console.log(`   ${balanceDiff === 0n ? "USER PAID ZERO GAS!" : "User was charged"}`);

  // Check that the profile was actually updated
  // Note: SampleDApp uses msg.sender, which in batched execution is the BatchExecutor
  // contract address. For proper sender preservation, use SampleDAppMeta with EIP-2771.
  // The key proof here is that the USER paid ZERO gas — the relayer covered it.
  const batchExecutorAddr = deployments.contracts.BatchExecutor;
  const profile = await sampleDApp.getProfile(batchExecutorAddr);
  console.log(`   Profile (stored via BatchExecutor): ${profile[0]} - "${profile[1]}"`);
  
  const stats = await sampleDApp.getStats();
  console.log(`   Total listings created: ${stats[0]}`);

  console.log("\n=== DEMO COMPLETE: Gasless batched meta-tx via relayer ===");
}

main().catch(console.error);
