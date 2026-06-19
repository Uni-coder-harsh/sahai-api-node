const crypto = require('crypto');

// Load AES key from environment. Must be exactly 32 bytes (256 bits).
// Standard fallback provided for local development convenience.
const SECRET_KEY = process.env.AES_SECRET_KEY || 'sahai-super-secret-key-123456789';

function decryptTelemetry(req, res, next) {
  const { iv, encryptedData } = req.body;
  
  if (!iv || !encryptedData) {
    console.error('[DecryptMiddleware] Rejecting telemetry request: missing iv or encryptedData.');
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Telemetry payload must be encrypted.'
    });
  }
  
  try {
    const ivBuffer = Buffer.from(iv, 'hex');
    const keyBuffer = Buffer.from(SECRET_KEY, 'utf8');
    
    if (keyBuffer.length !== 32) {
      throw new Error(`AES_SECRET_KEY must be exactly 32 bytes. Current length is ${keyBuffer.length}.`);
    }
    
    // Decrypt the AES-256-CBC encrypted payload
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, ivBuffer);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    // Replace req.body with the decrypted JSON object
    req.body = JSON.parse(decrypted);
    
    next();
  } catch (err) {
    console.error('[DecryptMiddleware] Decryption failed:', err.message);
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Decryption failed! Key mismatch or corrupted data.'
    });
  }
}

module.exports = {
  decryptTelemetry
};
