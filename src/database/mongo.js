const { MongoClient } = require('mongodb');
const config = require('../config');

const mongoClient = new MongoClient(config.MONGO_URI);
let mongoDb = null;

async function connectMongo() {
  if (mongoDb) return mongoDb;
  try {
    await mongoClient.connect();
    console.log('[Mongo] Connected to MongoDB event store.');
    mongoDb = mongoClient.db();
    return mongoDb;
  } catch (error) {
    console.error('[Mongo] Database connection failed:', error);
    throw error;
  }
}

function getMongoDb() {
  if (!mongoDb) {
    throw new Error('[Mongo] Database client not connected. Initialize connectMongo first.');
  }
  return mongoDb;
}

module.exports = {
  connectMongo,
  getMongoDb,
  mongoClient
};
