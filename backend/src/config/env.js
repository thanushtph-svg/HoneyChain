// Loads and validates environment variables from the project-root .env file.
// The app refuses to start with a clear message if something required is missing.
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '../../..');
loadDotenv({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres://user:pass@localhost:5432/honeychain)'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required (mongodb://127.0.0.1:27017)'),
  MONGODB_DB: z.string().default('honeychain'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  COOKIE_SECURE: bool,

  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  AI_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
  AI_SERVICE_KEY: z.string().min(16, 'AI_SERVICE_KEY must be at least 16 characters'),

  CHAIN_NETWORK: z.enum(['hardhat', 'sepolia']).default('hardhat'),
  HARDHAT_RPC_URL: z.string().default('http://127.0.0.1:8545'),
  HARDHAT_PRIVATE_KEY: z.string().optional(),
  SEPOLIA_RPC_URL: z.string().optional(),
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  ANCHOR_CONTRACT_ADDRESS: z.string().optional(),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(1).optional(),
  ANCHOR_WORKER_ENABLED: bool.default('true'),
  ANCHOR_WORKER_INTERVAL_MS: z.coerce.number().int().default(5000),

  ANOMALY_MIN_RECORDS: z.coerce.number().int().min(10).default(50),
  ANOMALY_INCLUDE_DEMO: bool,
  LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
  PUBLIC_REVERIFY_MINUTES: z.coerce.number().int().min(0).default(10),
  OUTBOX_WORKER_INTERVAL_MS: z.coerce.number().int().default(30000),
  SERVE_FRONTEND: bool,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('\n[config] Invalid or missing environment variables in .env:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  console.error('Copy .env.example to .env in the project root and fill in the values.\n');
  process.exit(1);
}

export const env = parsed.data;
export const isTest = env.NODE_ENV === 'test';
