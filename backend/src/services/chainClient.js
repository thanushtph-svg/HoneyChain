// Blockchain connection (ethers v6). Network chosen by CHAIN_NETWORK=hardhat|sepolia.
// Contract address comes from ANCHOR_CONTRACT_ADDRESS or blockchain/deployments/<network>.json
// (written by the deploy script), so nothing needs copying by hand.
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { env, PROJECT_ROOT } from '../config/env.js';

export const CHAIN_IDS = { hardhat: 31337, sepolia: 11155111 };

// Minimal ABI (matches blockchain/contracts/HoneyChainAnchor.sol)
export const ANCHOR_ABI = [
  'function anchor(bytes32 recordKey, bytes32 recordHash, uint16 scheme) returns (uint256 version)',
  'function latest(bytes32 recordKey) view returns (tuple(bytes32 recordHash, uint64 anchoredAt, uint16 scheme, address anchoredBy))',
  'function versionCount(bytes32 recordKey) view returns (uint256)',
  'function isAnchorer(address) view returns (bool)',
  'event RecordAnchored(bytes32 indexed recordKey, bytes32 recordHash, uint16 scheme, uint256 version, address indexed anchoredBy)',
];

let cached = null;

function readDeployment(network) {
  // hardhat network deployments are written under the name "localhost"
  const file = path.join(PROJECT_ROOT, 'blockchain', 'deployments', `${network === 'hardhat' ? 'localhost' : network}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Static configuration (no network calls). `configured` is false if any piece is missing. */
export function chainConfig() {
  const network = env.CHAIN_NETWORK;
  const rpcUrl = network === 'sepolia' ? env.SEPOLIA_RPC_URL : env.HARDHAT_RPC_URL;
  const privateKey = network === 'sepolia' ? env.DEPLOYER_PRIVATE_KEY : env.HARDHAT_PRIVATE_KEY;
  const deployment = readDeployment(network);
  const contractAddress = env.ANCHOR_CONTRACT_ADDRESS || deployment?.address || null;
  const missing = [];
  if (!rpcUrl) missing.push(network === 'sepolia' ? 'SEPOLIA_RPC_URL' : 'HARDHAT_RPC_URL');
  if (!privateKey) missing.push(network === 'sepolia' ? 'DEPLOYER_PRIVATE_KEY' : 'HARDHAT_PRIVATE_KEY');
  if (!contractAddress) missing.push('contract deployment (run the deploy script)');
  return {
    network,
    chainId: CHAIN_IDS[network],
    rpcUrl,
    privateKey,
    contractAddress: contractAddress ? ethers.getAddress(contractAddress) : null,
    confirmations: env.CHAIN_CONFIRMATIONS ?? (network === 'sepolia' ? 2 : 1),
    configured: missing.length === 0,
    missing,
  };
}

export function chain() {
  const cfg = chainConfig();
  if (!cfg.configured) return { cfg };
  if (cached && cached.key === `${cfg.rpcUrl}|${cfg.contractAddress}`) return cached;
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
  const wallet = new ethers.Wallet(cfg.privateKey, provider);
  const contract = new ethers.Contract(cfg.contractAddress, ANCHOR_ABI, wallet);
  cached = { key: `${cfg.rpcUrl}|${cfg.contractAddress}`, cfg, provider, wallet, contract };
  return cached;
}

/** Live status for the admin page and /health */
export async function chainStatus() {
  const c = chain();
  if (!c.provider) return { status: 'down', configured: false, network: c.cfg.network, detail: `Not configured: ${c.cfg.missing.join(', ')}` };
  try {
    const [net, block, code, balance] = await Promise.all([
      c.provider.getNetwork(),
      c.provider.getBlockNumber(),
      c.provider.getCode(c.cfg.contractAddress),
      c.provider.getBalance(c.wallet.address),
    ]);
    if (Number(net.chainId) !== c.cfg.chainId) {
      return { status: 'down', configured: true, network: c.cfg.network, detail: `RPC chainId ${net.chainId} does not match expected ${c.cfg.chainId}` };
    }
    const deployed = code && code !== '0x';
    let allowed = false;
    if (deployed) allowed = await c.contract.isAnchorer(c.wallet.address).catch(() => false);
    return {
      status: deployed ? 'up' : 'down',
      configured: true,
      network: c.cfg.network,
      chainId: c.cfg.chainId,
      contractAddress: c.cfg.contractAddress,
      contractDeployed: deployed,
      signer: c.wallet.address,
      signerIsAnchorer: allowed,
      signerBalanceEth: ethers.formatEther(balance),
      latestBlock: block,
      explorerBase: c.cfg.network === 'sepolia' ? 'https://sepolia.etherscan.io' : null,
      detail: deployed ? `${c.cfg.network} block ${block}` : 'No contract code at the configured address (local chain restarted? redeploy)',
    };
  } catch (e) {
    return { status: 'down', configured: true, network: c.cfg.network, detail: `RPC unreachable: ${e.shortMessage ?? e.message}` };
  }
}
