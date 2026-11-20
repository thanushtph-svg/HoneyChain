# Switching to the Sepolia testnet (final demonstration)

Local Hardhat is free and instant but is wiped every time the node stops. Sepolia is a public Ethereum **test** network: anchors are permanent, and anyone can see them on sepolia.etherscan.io. Sepolia ETH has **no monetary value**.

## 1. Create a dedicated wallet (never use a personal wallet)

1. Install **MetaMask** (browser extension) and create a **new** account just for this project.
2. In MetaMask, enable *Show test networks* and select **Sepolia**.
3. Copy the account address (`0x...`).
4. Export its private key: *Account details → Show private key*. Treat it like a password and **never** commit it.

## 2. Get a free RPC URL

Pick one:
- **Alchemy:** sign up at https://www.alchemy.com, create an app, choose *Ethereum → Sepolia*, and copy the HTTPS URL `https://eth-sepolia.g.alchemy.com/v2/<key>`.
- **Infura:** sign up at https://www.infura.io, create an API key, and use `https://sepolia.infura.io/v3/<key>`.

## 3. Get test ETH

Use a Sepolia faucet (e.g. the Alchemy or Google Cloud Web3 faucet). Many faucets require a small **mainnet** balance or a login to stop abuse; if one refuses, try another. About **0.05 Sepolia ETH** is plenty: deploying costs roughly 0.002–0.01 and each anchor far less, depending on network gas prices.

## 4. Configure `.env`

```ini
CHAIN_NETWORK=sepolia
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
DEPLOYER_PRIVATE_KEY=0xYOUR_NEW_WALLET_PRIVATE_KEY
```

`.env` is in `.gitignore`. Double-check with `git status` that it never appears as a file to commit.

## 5. Deploy and switch

```powershell
cd blockchain
npx hardhat run scripts/deploy.js --network sepolia
```

The script prints the contract address and an Etherscan link, and writes `deployments/sepolia.json`. The backend reads that file automatically, so no address needs copying.

Restart the backend. Then:
1. Admin → Blockchain: the network shows **sepolia (chainId 11155111)**, the contract, and your signer balance.
2. Click **Anchor missing records**. Every eligible record gets a new anchor on Sepolia. Records already anchored locally are first checked against their earlier hash; changed records are **refused**, not re-blessed.
3. Wait about 30 seconds per batch of anchors (2 confirmations). Public pages then show *view on Etherscan* links.

## 6. Switching back to local

Set `CHAIN_NETWORK=hardhat` and restart the backend. Each anchor row remembers which network and contract it was written to, so local and Sepolia anchors never get mixed up. Verification of an anchor on the other network reports `CHAIN_UNAVAILABLE` rather than a false result.

## Safety rules

- Only hashes go on-chain, never names, emails, phone numbers or raw records.
- Use the dedicated wallet only. If its key is ever exposed, abandon that wallet; it holds only valueless test ETH.
- Never put a mainnet key or real funds anywhere near this project.
