// In-memory TEST DOUBLE for the small subset of the MongoDB driver API that
// HoneyChain uses. It exists only so automated tests can run on machines
// without a MongoDB server (MONGODB_URI=memory://). It is NOT a database and
// must never be used for a real deployment - /api/v1/health reports it.
import { ObjectId } from 'mongodb';

// deep copy that keeps ObjectId and Date instances (structuredClone would strip ObjectId's class)
function clone(v) {
  if (v instanceof ObjectId) return new ObjectId(v.toHexString());
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

function getPath(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function setPath(doc, path, value) {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}
const cmp = (a, b) => {
  const x = a instanceof Date ? a.getTime() : a instanceof ObjectId ? a.toString() : a;
  const y = b instanceof Date ? b.getTime() : b instanceof ObjectId ? b.toString() : b;
  return x < y ? -1 : x > y ? 1 : 0;
};
const eq = (a, b) => (a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : cmp(a, b) === 0);

function matchValue(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof ObjectId) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$in': return arg.some((a) => (Array.isArray(value) ? value.some((v) => eq(v, a)) : eq(value, a)));
        case '$nin': return !arg.some((a) => eq(value, a));
        case '$ne': return !eq(value, arg);
        case '$gt': return value != null && cmp(value, arg) > 0;
        case '$gte': return value != null && cmp(value, arg) >= 0;
        case '$lt': return value != null && cmp(value, arg) < 0;
        case '$lte': return value != null && cmp(value, arg) <= 0;
        case '$exists': return (value !== undefined) === arg;
        case '$eq': return eq(value, arg);
        default: throw new Error(`memoryMongo: unsupported operator ${op}`);
      }
    });
  }
  if (Array.isArray(value)) return value.some((v) => eq(v, cond));
  return eq(value, cond);
}

export function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    // array-of-objects path like "ruleFindings.ruleId"
    const parts = k.split('.');
    const first = getPath(doc, parts[0]);
    if (Array.isArray(first) && parts.length > 1) {
      return first.some((el) => matchValue(getPath(el, parts.slice(1).join('.')), cond));
    }
    return matchValue(getPath(doc, k), cond);
  });
}

function sortDocs(docs, sort) {
  const entries = Object.entries(sort ?? {});
  return docs.sort((a, b) => {
    for (const [k, dir] of entries) {
      const c = cmp(getPath(a, k), getPath(b, k));
      if (c) return c * dir;
    }
    return 0;
  });
}

class Cursor {
  constructor(docs) { this.docs = docs; this._sort = null; this._skip = 0; this._limit = 0; }
  sort(s) { this._sort = s; return this; }
  skip(n) { this._skip = n; return this; }
  limit(n) { this._limit = n; return this; }
  async toArray() {
    let d = this._sort ? sortDocs([...this.docs], this._sort) : [...this.docs];
    d = d.slice(this._skip, this._limit ? this._skip + this._limit : undefined);
    return d.map(clone);
  }
}

function groupKey(doc, idSpec) {
  if (idSpec == null) return null;
  if (typeof idSpec === 'string' && idSpec.startsWith('$')) return getPath(doc, idSpec.slice(1));
  if (typeof idSpec === 'object') {
    return Object.fromEntries(Object.entries(idSpec).map(([k, v]) => [k, groupKey(doc, v)]));
  }
  return idSpec;
}

class MemoryCollection {
  constructor(name) { this.name = name; this.docs = []; }
  async createIndex() { return 'ok'; }
  async insertOne(doc) {
    const d = clone(doc);
    d._id ??= new ObjectId();
    this.docs.push(d);
    return { acknowledged: true, insertedId: d._id };
  }
  async insertMany(docs) {
    const ids = [];
    for (const d of docs) ids.push((await this.insertOne(d)).insertedId);
    return { acknowledged: true, insertedIds: ids };
  }
  find(filter = {}) { return new Cursor(this.docs.filter((d) => matches(d, filter))); }
  async findOne(filter = {}, opts = {}) {
    const res = await this.find(filter).sort(opts.sort).limit(1).toArray();
    return res[0] ?? null;
  }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async updateOne(filter, update) {
    const d = this.docs.find((x) => matches(x, filter));
    if (!d) return { matchedCount: 0, modifiedCount: 0 };
    for (const [k, v] of Object.entries(update.$set ?? {})) setPath(d, k, clone(v));
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async updateMany(filter, update) {
    const docs = this.docs.filter((x) => matches(x, filter));
    for (const d of docs) for (const [k, v] of Object.entries(update.$set ?? {})) setPath(d, k, clone(v));
    return { matchedCount: docs.length, modifiedCount: docs.length };
  }
  async deleteOne(filter) {
    const i = this.docs.findIndex((x) => matches(x, filter));
    if (i < 0) return { deletedCount: 0 };
    this.docs.splice(i, 1);
    return { deletedCount: 1 };
  }
  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((x) => !matches(x, filter));
    return { deletedCount: before - this.docs.length };
  }
  aggregate(pipeline) {
    let docs = this.docs.map(clone);
    for (const stage of pipeline) {
      const [op, spec] = Object.entries(stage)[0];
      if (op === '$match') docs = docs.filter((d) => matches(d, spec));
      else if (op === '$sort') docs = sortDocs(docs, spec);
      else if (op === '$limit') docs = docs.slice(0, spec);
      else if (op === '$unwind') {
        const p = (typeof spec === 'string' ? spec : spec.path).slice(1);
        docs = docs.flatMap((d) => (getPath(d, p) ?? []).map((v) => { const c = clone(d); setPath(c, p, v); return c; }));
      } else if (op === '$group') {
        const groups = new Map();
        for (const d of docs) {
          const key = groupKey(d, spec._id);
          const ks = JSON.stringify(key);
          if (!groups.has(ks)) groups.set(ks, { _id: key });
          const g = groups.get(ks);
          for (const [field, acc] of Object.entries(spec)) {
            if (field === '_id') continue;
            const [aop, aarg] = Object.entries(acc)[0];
            if (aop !== '$sum') throw new Error(`memoryMongo: unsupported accumulator ${aop}`);
            const v = typeof aarg === 'number' ? aarg : Number(getPath(d, aarg.slice(1)) ?? 0);
            g[field] = (g[field] ?? 0) + v;
          }
        }
        docs = [...groups.values()];
      } else throw new Error(`memoryMongo: unsupported stage ${op}`);
    }
    return new Cursor(docs);
  }
}

export function createMemoryDb() {
  const cols = new Map();
  return {
    isMemory: true,
    collection(name) {
      if (!cols.has(name)) cols.set(name, new MemoryCollection(name));
      return cols.get(name);
    },
    async createCollection(name) { return this.collection(name); },
    listCollections() { return { toArray: async () => [...cols.keys()].map((name) => ({ name })) }; },
    async command() { return { ok: 1 }; },
    async dropDatabase() { cols.clear(); },
  };
}
