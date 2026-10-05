const { MongoClient } = require('mongodb');

let db;

// Connection string has no default database segment, so the name is
// supplied here rather than relying on the URI. MONGO_DB_NAME overrides it
// (e.g. wordpuzzle_test for the scratch verification scripts).
async function connectDb() {
  if (db) return db;
  const uri = process.env.MONGO_CONN_STRING;
  if (!uri) throw new Error('MONGO_CONN_STRING is not set');
  const client = new MongoClient(uri);
  await client.connect();
  console.log('[db] connected to Space');
  db = client.db(process.env.MONGO_DB_NAME || 'wordpuzzle');
  return db;
}

module.exports = { connectDb };
