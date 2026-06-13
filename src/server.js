const app = require('./app');
const config = require('./config');
const { connectMongo } = require('./database/mongo');
const logger = require('./utils/logger');

async function bootstrap() {
  try {
    // Connect to MongoDB Event Store
    await connectMongo();

    // Start Express API Listener
    app.listen(config.PORT, () => {
      logger.info(`Node.js API Service running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error('Bootstrapping failed:', error);
    process.exit(1);
  }
}

bootstrap();
