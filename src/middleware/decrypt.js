const crypto = require('crypto');

// Load AES keys
const DEFAULT_SECRET_KEY = 'sahai-super-secret-key-123456789';
const CONFIGURED_SECRET_KEY = process.env.AES_SECRET_KEY;

function attemptDecryption(encryptedData, iv, secretKey) {
  if (!secretKey) return null;
  const keyBuffer = Buffer.from(secretKey, 'utf8');
  if (keyBuffer.length !== 32) {
    console.warn(`[DecryptMiddleware] Key is not 32 bytes (length is ${keyBuffer.length}). Skipping key.`);
    return null;
  }
  
  const ivBuffer = Buffer.from(iv, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

function decryptTelemetry(req, res, next) {
  const { iv, encryptedData } = req.body;
  
  if (!iv || !encryptedData) {
    console.error('[DecryptMiddleware] Rejecting telemetry request: missing iv or encryptedData.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Telemetry payload must be encrypted.'
    });
  }
  
  // Try 1: Decrypt with configured key
  if (CONFIGURED_SECRET_KEY) {
    try {
      const decrypted = attemptDecryption(encryptedData, iv, CONFIGURED_SECRET_KEY);
      if (decrypted) {
        req.body = decrypted;
        return next();
      }
    } catch (err) {
      console.warn(`[DecryptMiddleware] Configured key decryption failed: ${err.message}. Attempting default fallback key...`);
    }
  }
  
  // Try 2: Decrypt with default key
  try {
    const decrypted = attemptDecryption(encryptedData, iv, DEFAULT_SECRET_KEY);
    if (decrypted) {
      req.body = decrypted;
      return next();
    }
  } catch (err) {
    console.error(`[DecryptMiddleware] Default fallback decryption failed: ${err.message}`);
  }
  
  // If both failed
  return res.status(403).json({
    error: 'Forbidden',
    message: 'Decryption failed! Key mismatch or corrupted data.'
  });
}

module.exports = {
  decryptTelemetry
};

