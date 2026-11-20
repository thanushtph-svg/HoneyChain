// MongoDB access (secondary database: AI results, spectral scans, anomaly reports, activity logs).
import { MongoClient, ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { createMemoryDb } from './memoryMongo.js';

let client = null;
let db = null;
let mode = 'disconnected';

export { ObjectId };

export async function connectMongo() {
  if (db) return db;
  if (env.MONGODB_URI.startsWith('memory://')) {
    // Test double used only by automated tests in environments without MongoDB.
    console.warn('[mongo] MONGODB_URI=memory:// -> using in-memory TEST DOUBLE, not a real MongoDB server');
    db = createMemoryDb();
    mode = 'memory-test-double';
    return db;
  }
  client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  db = client.db(env.MONGODB_DB);
  mode = 'mongodb';
  return db;
}

/** Returns the db handle, connecting lazily. Throws if MongoDB is unreachable. */
export async function mongo() {
  return db ?? connectMongo();
}

export async function collection(name) {
  return (await mongo()).collection(name);
}

export async function closeMongo() {
  if (client) await client.close();
  client = null;
  db = null;
  mode = 'disconnected';
}

export async function mongoHealth() {
  try {
    const d = await mongo();
    if (mode === 'memory-test-double') return { status: 'up', detail: 'in-memory test double (not MongoDB)' };
    const info = await d.command({ buildInfo: 1 });
    return { status: 'up', detail: `MongoDB ${info.version}` };
  } catch (e) {
    db = null;
    return { status: 'down', detail: e.message };
  }
}

/** Convert a string to ObjectId or return null if it isn't a valid id. */
export function toObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id) ? new ObjectId(id) : null;
}
