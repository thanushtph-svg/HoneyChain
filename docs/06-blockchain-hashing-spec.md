# 06 — Blockchain & Hashing Specification (scheme `hc-v1`)

## 1. What blockchain does and does not prove

> Blockchain verification proves only that **the record in our database still matches the version that was anchored**. It does not prove that the original data was true, that a lab test was done correctly, or that the honey is genuine.

This sentence appears on the admin verification page and, in simpler words, on the public page.

## 2. Which records are anchored, and when

| Entity type | Anchored when | Why it's safe to anchor then |
|---|---|---|
| `BATCH_ORIGIN` | Batch created | Batch quantity/harvest freeze after CREATED; harvest freezes once batched (DB triggers) |
| `LAB_REPORT` | Report SUBMITTED | Submitted reports are immutable (trigger) |
| `PROCESSING_RECORD` | Record created | Processing records are append-only (trigger) |
| `SHIPMENT` | Status becomes DELIVERED | Only status/date may change, and DELIVERED is final |

Because the database itself forbids legitimate edits after anchoring, **any later difference means tampering outside the application** (e.g. direct SQL). Phase 8 includes a scripted demo of exactly that: disable the trigger in psql, change a value, verify → **MISMATCH**.

Anchoring happens **after** the PostgreSQL commit. The `PENDING` row is written inside the business transaction, so the intent to anchor is never lost (see doc 01 §3).

## 3. Canonical serialization

Goal: the same record version always produces the same bytes on every machine.

1. Build an envelope:
   ```json
   { "scheme": "hc-v1", "entityType": "...", "entityCode": "...", "batchCode": "...", "data": { ... } }
   ```
2. **Keys** in camelCase; **every** listed field is present, using `null` when empty (a missing key and a null would otherwise hash differently).
3. **Decimals** (NUMERIC columns) are **strings with the column's fixed scale**, exactly as PostgreSQL returns them: `"17.80"`, not `17.8`. This avoids float rounding differences between JavaScript and Python.
4. **Integers** (`unitSizeG`, `unitsPacked`, `unitsShipped`) are JSON numbers.
5. **Dates** are `"YYYY-MM-DD"`. Timestamps are not included (timezone formatting is a common source of mismatches).
6. **Strings** are Unicode NFC-normalized and stored trimmed (the API trims on input).
7. **References use codes**, not integer ids (`labOrgCode: "ORG-0001"`), so the hash survives a dump/restore that renumbers rows.
8. **No personal data** in the hash input: no names, emails, phone numbers, operator names, staff ids or tracking references. (Only the hash goes on-chain anyway; this keeps even the preimage free of personal data.)
9. Serialize with **keys sorted** (recursively) and **no whitespace**. This is the RFC 8785 (JCS) form for our data types. The backend uses the `canonicalize` npm package.

## 4. Hash and record key

```
recordHash = "0x" + SHA-256( UTF-8( canonicalJson ) )                    → bytes32
recordKey  = "0x" + SHA-256( UTF-8( "honeychain|" + entityType + "|" + entityCode ) ) → bytes32
```

`recordKey` is an opaque lookup key, so the chain never shows the codes in plain text. The scheme version is not part of the key: if `hc-v2` is introduced later, a record's anchor history stays under one key, with the scheme number stored alongside each hash.

## 5. Field lists per entity (`data` object)

| Entity | Fields (camelCase) |
|---|---|
| `BATCH_ORIGIN` | `quantityKg, honeyType, createdOn, beekeeperCode, harvest{harvestCode, harvestDate, quantityKg, floralSource}, hive{hiveCode, hiveType, beeSpecies, district, state}` |
| `LAB_REPORT` | `labOrgCode, sampleCode, receivedOn, testedOn, moisturePct, hmfMgKg, sucroseG100g, glucoseG100g, fructoseG100g, brix, ph, freeAcidityMeqKg, waterActivity, electricalConductivityMsCm, pollenIdentification, adulterationMethod, adulterationResult, decision, decisionRemarks` |
| `PROCESSING_RECORD` | `processorOrgCode, processingDate, method, methodDetails, inputQuantityKg, outputQuantityKg, packagingDate, packagingType, unitSizeG, unitsPacked, bestBefore` |
| `SHIPMENT` | `distributorOrgCode, dispatchDate, originLocation, destinationName, destinationType, destinationCity, destinationState, carrierName, unitsShipped, status, deliveredOn` |

## 6. Worked example (test vector)

Input record (lab report):

```json
{"batchCode":"HC-2026-000123","data":{"adulterationMethod":"C4 sugar (SCIRA)","adulterationResult":"NOT_DETECTED","brix":null,"decision":"PASS","decisionRemarks":"Within limits","electricalConductivityMsCm":null,"freeAcidityMeqKg":null,"fructoseG100g":null,"glucoseG100g":null,"hmfMgKg":"9.60","labOrgCode":"ORG-0001","moisturePct":"17.80","ph":null,"pollenIdentification":"Multifloral pollen observed","receivedOn":"2026-08-28","sampleCode":"S-0828-047-A","sucroseG100g":"3.10","testedOn":"2026-08-28","waterActivity":null},"entityCode":"LAB-2026-000045","entityType":"LAB_REPORT","scheme":"hc-v1"}
```

| Value | Result |
|---|---|
| `recordHash` | `0xd33ca2e7547e1d17afa06427a2d91073e4fcbed267ab5cdfad91df17db9d2093` |
| `recordKey` (`honeychain|LAB_REPORT|LAB-2026-000045`) | `0xb3a2ef7b7bf86228dfb2b64934c85aa884e3d91e98fe8b17622970790960c8b6` |
| Hash after changing moisture `17.80 → 15.80` | `0xe438d34c28d36536730b967c12c6e49e12b71b92f38f0789468d9734f999a42b` (completely different → MISMATCH) |

The Phase 8 unit tests must reproduce these exact values in both Node.js and Python.

## 7. Smart contract `HoneyChainAnchor.sol` (interface)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract HoneyChainAnchor {
    struct Anchor {
        bytes32 recordHash;
        uint64  anchoredAt;     // block timestamp
        uint16  scheme;         // 1 = hc-v1
        address anchoredBy;
    }

    address public owner;
    mapping(address => bool) public isAnchorer;           // backend signer(s)
    mapping(bytes32 => Anchor[]) private _history;        // recordKey → append-only list

    event RecordAnchored(bytes32 indexed recordKey, bytes32 recordHash, uint16 scheme,
                         uint256 version, address indexed anchoredBy);
    event AnchorerSet(address indexed account, bool allowed);

    function anchor(bytes32 recordKey, bytes32 recordHash, uint16 scheme)
        external returns (uint256 version);               // onlyAnchorer; reverts on zero hash
    function latest(bytes32 recordKey) external view returns (Anchor memory);  // reverts if none
    function anchorAt(bytes32 recordKey, uint256 version) external view returns (Anchor memory);
    function versionCount(bytes32 recordKey) external view returns (uint256);
    function setAnchorer(address account, bool allowed) external;              // onlyOwner
}
```

Design choices:
- **Append-only.** There is no update or delete function, so an anchored hash can never be overwritten, only followed by a newer version.
- **Access control.** Only allow-listed signers can anchor, which stops strangers spamming fake anchors under our keys.
- **Minimal data.** Only a 32-byte key and a 32-byte hash, which keeps gas low and leaks no personal data.

## 8. Anchoring flow (backend worker)

```
PENDING ──send tx──▶ SUBMITTED (tx_hash stored) ──receipt status=1──▶ CONFIRMED (block_number, block_timestamp)
   │                       │
   └──RPC error──▶ retry (attempts++) ; after 5 → FAILED      └──reverted──▶ FAILED (failure_reason)
```

- Confirmations required: Hardhat 1, Sepolia 2 (configurable).
- The worker reads `tx_hash`, `block_number` and timestamp **from the receipt returned by the node**. They are never generated by the app, and the DB CHECK forbids CONFIRMED without them.

## 9. Verification flow

```
1. load record from PostgreSQL → build canonical JSON → recomputedHash
2. contract.latest(recordKey) on the anchor's network/contract
3. compare
     equal                 → VERIFIED
     different             → MISMATCH
     no anchor / no code   → NOT_FOUND_ON_CHAIN
     RPC error             → CHAIN_UNAVAILABLE
4. INSERT verification_checks (result, both hashes, who/what triggered it)
```

## 10. Networks

| | Hardhat (default) | Sepolia (final demo) |
|---|---|---|
| Chain id | 31337 | 11155111 |
| RPC | `http://127.0.0.1:8545` (`npx hardhat node`) | `SEPOLIA_RPC_URL` (Alchemy/Infura, free tier) |
| Signer | Hardhat's pre-funded test account #0 | `DEPLOYER_PRIVATE_KEY`: a **new, dedicated** wallet holding only test ETH |
| Cost | Free, instant | Test ETH from a faucet (setup explained at deployment time) |
| Persistence | **Lost when the node stops** (records then show NOT_FOUND_ON_CHAIN until re-anchored) | Permanent; viewable on sepolia.etherscan.io |
| Explorer link | none | `https://sepolia.etherscan.io/tx/<tx_hash>` |

Selected via `CHAIN_NETWORK=hardhat|sepolia`. Each network has its own `ANCHOR_CONTRACT_ADDRESS`, and anchors record which network and contract they live on, so mixing them up is impossible.
