const app = require('./app');
const config = require('./config');
const { connectMongo } = require('./database/mongo');

async function bootstrap() {
  try {
    // Connect to MongoDB Event Store
    await connectMongo();

    // Start Express API Listener
    app.listen(config.PORT, () => {
      console.log(`[Server] Node.js API Service running on port ${config.PORT}`);
    });
  } catch (error) {
    console.error('[Server] Bootstrapping failed:', error);
    process.exit(1);
  }
}

bootstrap();
