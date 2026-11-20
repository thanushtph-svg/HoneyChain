// Creates MongoDB collections with $jsonSchema validators and indexes from mongo/collections.json.
// Safe to re-run: existing collections get their validator updated (collMod).
// Usage:  npm run db:mongo-init
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mongo, closeMongo } from '../src/db/mongo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const design = JSON.parse(fs.readFileSync(path.join(here, 'mongo', 'collections.json'), 'utf8'));

export async function mongoInit({ quiet = false } = {}) {
  const db = await mongo();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, spec] of Object.entries(design.collections)) {
    if (db.isMemory) {
      db.collection(name);
    } else if (existing.has(name)) {
      await db.command({ collMod: name, validator: spec.validator, validationLevel: 'strict', validationAction: 'error' });
    } else {
      await db.createCollection(name, { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' });
    }
    for (const idx of spec.indexes) {
      const { keys, _comment, ...options } = idx;
      await db.collection(name).createIndex(keys, options);
    }
    if (!quiet) console.log(`[mongo-init] ${name}: validator + ${spec.indexes.length} index(es) ready`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mongoInit()
    .then(() => closeMongo())
    .catch(async (e) => {
      console.error('[mongo-init] ERROR:', e.message);
      if (/ECONNREFUSED|Server selection timed out/.test(e.message)) console.error('Is the MongoDB service running? Check MONGODB_URI in .env');
      await closeMongo();
      process.exit(1);
    });
}
