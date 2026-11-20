// Hardhat configuration.
//  - "hardhat"/"localhost": local development chain (npx hardhat node, chainId 31337)
//  - "sepolia": public testnet, configured from the project-root .env
// The Solidity compiler is taken from the bundled `solc` npm package (solc-js 0.8.24),
// so compiling works offline and identically on Windows, macOS and Linux.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
require('@nomicfoundation/hardhat-toolbox');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

const SOLC_VERSION = '0.8.24';

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const solcPkg = require('solc/package.json');
    return {
      compilerPath: require.resolve('solc/soljson.js'),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: solcPkg.version,
    };
  }
  return runSuper();
});

const sepoliaUrl = process.env.SEPOLIA_RPC_URL || '';
const sepoliaKey = process.env.DEPLOYER_PRIVATE_KEY || '';

module.exports = {
  solidity: { version: SOLC_VERSION, settings: { optimizer: { enabled: true, runs: 200 } } },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545', chainId: 31337 },
    ...(sepoliaUrl && sepoliaKey
      ? { sepolia: { url: sepoliaUrl, chainId: 11155111, accounts: [sepoliaKey.startsWith('0x') ? sepoliaKey : `0x${sepoliaKey}`] } }
      : {}),
  },
};
