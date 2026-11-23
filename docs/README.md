# HoneyChain — Documentation

| Doc | What it answers |
|---|---|
| [01-architecture](01-architecture.md) | Services, request flows, cross-database consistency, security, ports/env |
| [02-er-diagram](02-er-diagram.md) | ER diagram (Mermaid), cardinalities, normalization to 3NF |
| [03-postgresql-design](03-postgresql-design.md) | Tables, DB-enforced rules, transactions, locking, indexes, views |
| [04-mongodb-design](04-mongodb-design.md) | Collections, why NoSQL, links to SQL rows, CRUD, failure handling |
| [05-api-contract](05-api-contract.md) | Every REST endpoint, role, body and error format |
| [06-blockchain-hashing-spec](06-blockchain-hashing-spec.md) | What is anchored, canonical JSON, hash test vector, contract, verify flow |
| [07-ai-service-design](07-ai-service-design.md) | Model gating, dataset questions, rules vs ML, anomaly minimum-data rule |
| [08-repository-structure](08-repository-structure.md) | Final folder layout and reuse map |
| [09-decision-log](09-decision-log.md) | Every design decision and its source |
| [10-role-based-views](10-role-based-views.md) | The six role views, workflow/custody, RBAC layers, API and DB changes |
| [testing](testing.md) | All test suites, latest results, manual checks |
| [sepolia-setup](sepolia-setup.md) | Wallet, RPC key, test ETH, deploy to Sepolia |
| [sql/demo_queries.sql](sql/demo_queries.sql) | 13 DBMS demonstration queries (joins, GROUP BY, subqueries, window, EXPLAIN, transaction) |
| [../ai-service/README.md](../ai-service/README.md) | AI models, evaluation, retraining |

Executable design artifacts:

- `backend/db/migrations/001–005*.sql`: PostgreSQL DDL (tested on PostgreSQL 16 and 18)
- `backend/db/tests/schema_tests.sql`: 78 automated schema checks
- `backend/db/mongo/collections.json`: MongoDB validators and indexes
