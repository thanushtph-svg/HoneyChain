// Imported FIRST by every test file: points the app at a separate test database.
// Uses DATABASE_URL from .env with the database name replaced by "<name>_test".
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
config({ path: path.join(root, '.env'), quiet: true });
const url = new URL(process.env.DATABASE_URL);
if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
process.env.MONGODB_DB = 'honeychain_test';
process.env.ANCHOR_WORKER_ENABLED = 'false';
// Use the in-memory Mongo test double unless TEST_MONGODB_URI points at a real server
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'memory://';
