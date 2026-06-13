const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../../logs');
const logFilePath = path.join(logsDir, 'app.log');

// Ensure local logs folder exists for local running
if (process.env.NODE_ENV !== 'production') {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// Regex to find sensitive information in strings
const SENSITIVE_PATTERNS = [
  /mongodb\+srv:\/\/[^@]+@[^\s/]+/gi,       // MongoDB connection secrets
  /redis:\/\/([^@]+)@[^\s/]+/gi,             // Redis credentials
  /pass(word)?\s*=\s*[^\s;&]+/gi,            // DB passwords in URLs/params
  /"password"\s*:\s*"[^"]*"/gi,             // JSON password keys
];

/**
 * Sanitizes input text, removing credentials and keys.
 */
function sanitize(message) {
  if (typeof message !== 'string') {
    message = JSON.stringify(message);
  }
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.startsWith('mongodb+srv:')) return 'mongodb+srv://[REDACTED_CREDENTIALS]@host';
      if (match.startsWith('redis:')) return 'redis://default:[REDACTED_TOKEN]@host';
      if (match.toLowerCase().includes('password')) return 'password=[REDACTED]';
      return '[REDACTED]';
    });
  }
  return sanitized;
}

/**
 * Formats the log payload in standard enterprise format.
 */
function formatLog(level, message, context = null) {
  const timestamp = new Date().toISOString();
  const sanitizedMsg = sanitize(message);
  const contextStr = context ? ` | Context: ${sanitize(JSON.stringify(context))}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${sanitizedMsg}${contextStr}`;
}

/**
 * Enterprise level logging class.
 */
class Logger {
  info(message, context = null) {
    const formatted = formatLog('INFO', message, context);
    console.log(formatted);
    this._writeToLocalFile(formatted);
  }

  warn(message, context = null) {
    const formatted = formatLog('WARN', message, context);
    console.warn(formatted);
    this._writeToLocalFile(formatted);
  }

  error(message, context = null) {
    const formatted = formatLog('ERROR', message, context);
    console.error(formatted);
    this._writeToLocalFile(formatted);
  }

  _writeToLocalFile(formattedLine) {
    // Only write to file if not in production/cloud container context
    if (process.env.NODE_ENV !== 'production') {
      try {
        fs.appendFileSync(logFilePath, formattedLine + '\n', 'utf8');
      } catch (err) {
        console.error('[Logger] Failed to write to local log file:', err.message);
      }
    }
  }
}

module.exports = new Logger();
