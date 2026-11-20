// Deploys HoneyChainAnchor and records the address in deployments/<network>.json.
// The backend reads that file automatically.
//   Local:   npx hardhat run scripts/deploy.js --network localhost
//   Sepolia: npx hardhat run scripts/deploy.js --network sepolia
const fs = require('node:fs');
const path = require('node:path');
const hre = require('hardhat');

async function main() {
  const network = hre.network.name;
  if (network === 'hardhat') {
    throw new Error('Use --network localhost (with `npx hardhat node` running) so the contract outlives this script.');
  }
  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Network:  ${network} (chainId ${(await hre.ethers.provider.getNetwork()).chainId})`);
  console.log(`Deployer: ${deployer.address}  balance ${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error('Deployer has 0 ETH. On Sepolia, get test ETH from a faucet first.');

  const Factory = await hre.ethers.getContractFactory('HoneyChainAnchor');
  const contract = await Factory.deploy();
  const tx = contract.deploymentTransaction();
  console.log(`Deploy tx: ${tx.hash} (waiting for confirmation...)`);
  await contract.waitForDeployment();
  const receipt = await tx.wait(network === 'sepolia' ? 2 : 1);
  const address = await contract.getAddress();

  const out = {
    network,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    address,
    deployer: deployer.address,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network}.json`), JSON.stringify(out, null, 2));
  console.log(`HoneyChainAnchor deployed at ${address} (block ${receipt.blockNumber})`);
  console.log(`Saved deployments/${network}.json - restart the backend to pick it up.`);
  if (network === 'sepolia') console.log(`Explorer: https://sepolia.etherscan.io/address/${address}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exitCode = 1;
});
