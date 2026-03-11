const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("============================================");
  console.log("Gas Fee Optimizer - Deployment Script");
  console.log("============================================\n");

  const [deployer, relayer] = await hre.ethers.getSigners();
  
  console.log("Deployer address:", deployer.address);
  console.log("Relayer address:", relayer?.address || "Not available");
  console.log("Deployer balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");

  // 1. Deploy BatchExecutor
  console.log("1. Deploying BatchExecutor...");
  const BatchExecutor = await hre.ethers.getContractFactory("BatchExecutor");
  const batchExecutor = await BatchExecutor.deploy();
  await batchExecutor.waitForDeployment();
  const batchExecutorAddress = await batchExecutor.getAddress();
  console.log("   BatchExecutor deployed to:", batchExecutorAddress);

  // 2. Deploy GasSponsor
  console.log("\n2. Deploying GasSponsor...");
  const GasSponsor = await hre.ethers.getContractFactory("GasSponsor");
  const gasSponsor = await GasSponsor.deploy(batchExecutorAddress);
  await gasSponsor.waitForDeployment();
  const gasSponsorAddress = await gasSponsor.getAddress();
  console.log("   GasSponsor deployed to:", gasSponsorAddress);

  // 3. Deploy Forwarder
  console.log("\n3. Deploying Forwarder...");
  const Forwarder = await hre.ethers.getContractFactory("Forwarder");
  const forwarder = await Forwarder.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  console.log("   Forwarder deployed to:", forwarderAddress);

  // 4. Deploy GaslessToken
  console.log("\n4. Deploying GaslessToken...");
  const GaslessToken = await hre.ethers.getContractFactory("GaslessToken");
  const gaslessToken = await GaslessToken.deploy(forwarderAddress);
  await gaslessToken.waitForDeployment();
  const gaslessTokenAddress = await gaslessToken.getAddress();
  console.log("   GaslessToken deployed to:", gaslessTokenAddress);

  // 5. Deploy SampleDApp
  console.log("\n5. Deploying SampleDApp...");
  const SampleDApp = await hre.ethers.getContractFactory("SampleDApp");
  const sampleDApp = await SampleDApp.deploy();
  await sampleDApp.waitForDeployment();
  const sampleDAppAddress = await sampleDApp.getAddress();
  console.log("   SampleDApp deployed to:", sampleDAppAddress);

  // 6. Deploy CompressedBatchExecutor
  console.log("\n6. Deploying CompressedBatchExecutor...");
  const CompressedBatchExecutor = await hre.ethers.getContractFactory("CompressedBatchExecutor");
  const compressedBatchExecutor = await CompressedBatchExecutor.deploy();
  await compressedBatchExecutor.waitForDeployment();
  const compressedBatchExecutorAddress = await compressedBatchExecutor.getAddress();
  console.log("   CompressedBatchExecutor deployed to:", compressedBatchExecutorAddress);

  // 7. Deploy SampleDAppMeta (trusts CompressedBatchExecutor as forwarder)
  console.log("\n7. Deploying SampleDAppMeta...");
  const SampleDAppMeta = await hre.ethers.getContractFactory("SampleDAppMeta");
  const sampleDAppMeta = await SampleDAppMeta.deploy(compressedBatchExecutorAddress);
  await sampleDAppMeta.waitForDeployment();
  const sampleDAppMetaAddress = await sampleDAppMeta.getAddress();
  console.log("   SampleDAppMeta deployed to:", sampleDAppMetaAddress);

  // 8. Configure contracts
  console.log("\n============================================");
  console.log("Configuring contracts...");
  console.log("============================================\n");

  // Link BatchExecutor to GasSponsor
  console.log("- Setting GasSponsor on BatchExecutor...");
  await batchExecutor.setGasSponsor(gasSponsorAddress);

  // Register deployer as a relayer (for testing)
  console.log("- Registering deployer as relayer on GasSponsor...");
  await gasSponsor.setRelayer(deployer.address, true);

  // If we have a second account, register it as relayer too
  if (relayer) {
    console.log("- Registering second account as relayer...");
    await gasSponsor.setRelayer(relayer.address, true);
    await batchExecutor.setRelayerAuthorization(relayer.address, true);
  }

  // Fund the GasSponsor with some ETH
  const isTestnet = hre.network.name !== "hardhat" && hre.network.name !== "localhost";
  const depositAmount = isTestnet ? "0.005" : "1";
  console.log(`- Funding GasSponsor with ${depositAmount} ETH...`);
  await gasSponsor.deposit({ value: hre.ethers.parseEther(depositAmount) });

  console.log("\n============================================");
  console.log("Deployment Complete!");
  console.log("============================================\n");

  // Print summary
  const deploymentInfo = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    contracts: {
      BatchExecutor: batchExecutorAddress,
      CompressedBatchExecutor: compressedBatchExecutorAddress,
      GasSponsor: gasSponsorAddress,
      Forwarder: forwarderAddress,
      GaslessToken: gaslessTokenAddress,
      SampleDApp: sampleDAppAddress,
      SampleDAppMeta: sampleDAppMetaAddress
    },
    deployer: deployer.address,
    relayer: relayer?.address || null
  };

  console.log("Deployment Info:");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  // Save deployment info to file
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  const deploymentFile = path.join(deploymentsDir, `${hre.network.name}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment info saved to: ${deploymentFile}`);

  // Verify contracts on Etherscan if not on local network
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\n============================================");
    console.log("Verifying contracts on Etherscan...");
    console.log("============================================\n");
    
    const contractsToVerify = [
      { address: batchExecutorAddress, args: [], name: "BatchExecutor" },
      { address: compressedBatchExecutorAddress, args: [], name: "CompressedBatchExecutor" },
      { address: gasSponsorAddress, args: [batchExecutorAddress], name: "GasSponsor" },
      { address: forwarderAddress, args: [], name: "Forwarder" },
      { address: gaslessTokenAddress, args: [forwarderAddress], name: "GaslessToken" },
      { address: sampleDAppAddress, args: [], name: "SampleDApp" },
      { address: sampleDAppMetaAddress, args: [compressedBatchExecutorAddress], name: "SampleDAppMeta" },
    ];

    for (const c of contractsToVerify) {
      try {
        await hre.run("verify:verify", { address: c.address, constructorArguments: c.args });
        console.log(`${c.name} verified!`);
      } catch (e) {
        console.log(`${c.name} verification: ${e.message}`);
      }
    }

    // Generate hosted frontend with embedded addresses
    console.log("\n============================================");
    console.log("Generating hosted frontend...");
    console.log("============================================\n");

    const frontendSrc = fs.readFileSync(path.join(__dirname, "..", "frontend", "index.html"), "utf-8");
    const hosted = frontendSrc.replace(
      /const DEPLOYED = \{[^}]*\};/s,
      `const DEPLOYED = {\n` +
      `                BatchExecutor: "${batchExecutorAddress}",\n` +
      `                CompressedBatchExecutor: "${compressedBatchExecutorAddress}",\n` +
      `                SampleDApp: "${sampleDAppAddress}",\n` +
      `            };`
    );
    const hostedDir = path.join(__dirname, "..", "hosted");
    if (!fs.existsSync(hostedDir)) fs.mkdirSync(hostedDir, { recursive: true });
    fs.writeFileSync(path.join(hostedDir, "index.html"), hosted);
    console.log("Hosted frontend saved to: hosted/index.html");
    console.log("Upload this file to Vercel, Netlify, or GitHub Pages!\n");

    const chainName = hre.network.name;
    const explorerBase = chainName === "sepolia" ? "https://sepolia.etherscan.io" : "https://etherscan.io";
    console.log("Frontend URL params (alternative):");
    console.log(`  ?batch=${batchExecutorAddress}&compressed=${compressedBatchExecutorAddress}&dapp=${sampleDAppAddress}\n`);
    console.log("Contract links:");
    for (const c of contractsToVerify) {
      console.log(`  ${c.name}: ${explorerBase}/address/${c.address}`);
    }
  }

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
