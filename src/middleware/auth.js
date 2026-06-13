const crypto = require('crypto');

// Load secret from environment or fallback
const SECRET_KEY = process.env.JWT_SECRET || 'Bayes_45Ro_Secret_Key_For_AES256_Encryption';

/**
 * Decrypts a token to retrieve the original user ID.
 */
function verifyToken(token) {
  if (!token) return null;
  try {
    const key = crypto.scryptSync(SECRET_KEY, 'salt', 32);
    const iv = Buffer.alloc(16, 0); // Fixed IV for deterministic token verification
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(token, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[AuthMiddleware] Token decryption failed:', err.message);
    return null;
  }
}

/**
 * Generates an encrypted token for a user ID.
 */
function generateToken(userId) {
  const key = crypto.scryptSync(SECRET_KEY, 'salt', 32);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(userId, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

/**
 * Express middleware to authenticate requests.
 */
function authRequired(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Authorization header missing or malformed.' });
  }

  const token = authHeader.split(' ')[1];
  const userId = verifyToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication failed. Invalid or expired token.' });
  }

  // Attach authenticated user ID to the request object
  req.userId = userId;
  next();
}

module.exports = {
  authRequired,
  generateToken,
  verifyToken
};
