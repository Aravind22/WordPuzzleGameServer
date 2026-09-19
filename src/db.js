const { MongoClient } = require('mongodb');

let db;

// Connection string has no default database segment, so the name is
// supplied here rather than relying on the URI.
async function connectDb() {
  if (db) return db;
  const uri = process.env.MONGO_CONN_STRING;
  if (!uri) throw new Error('MONGO_CONN_STRING is not set');
  const client = new MongoClient(uri);
  await client.connect();
  db = client.db('wordpuzzle');
  return db;
}

module.exports = { connectDb };
