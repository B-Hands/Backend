import winston from 'winston'
import * as fs from 'fs'
import * as path from 'path'

// Ensure logs directory exists with fail-safe handling
const logsDir = path.join(process.cwd(), 'logs')
try {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
} catch (error) {
  // If we can't create logs directory, fall back to console-only logging
  console.error('[Logger] Failed to create logs directory, using console-only:', error)
}

// Sensitive data patterns to redact
const SENSITIVE_PATTERNS = [
  /password["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /secret["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /token["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /authorization["']?\s*[:=]\s*["']?([^\s"'}]+)/gi,
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /sk-[a-zA-Z0-9]{32,}/g, // Stripe-like keys
  /xoxb-[a-zA-Z0-9-]+/g, // Slack tokens
  /[a-f0-9]{64}/g, // 64-char hex strings (likely encryption keys)
]

function redactSensitiveData(message: string): string {
  let redacted = message
  for (const pattern of SENSITIVE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      // Keep first 4 chars for debugging, rest as asterisks
      const visible = match.substring(0, 4)
      return `${visible}${'*'.repeat(match.length - 4)}`
    })
  }
  return redacted
}

// Custom format that redacts sensitive data
const redactFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const safeMessage = typeof message === 'string' ? redactSensitiveData(message) : message
  const safeMeta: any = {}
  for (const [key, value] of Object.entries(meta)) {
    safeMeta[key] = typeof value === 'string' ? redactSensitiveData(value) : value
  }
  const metaStr = Object.keys(safeMeta).length ? JSON.stringify(safeMeta) : ''
  return `${timestamp} [${level}]: ${safeMessage} ${metaStr}`
})

// Determine log level from environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
const isProduction = process.env.NODE_ENV === 'production'

// Create base transports array
const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      redactFormat
    ),
  }),
]

// Add file transports only if logs directory is writable
if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
  try {
    // Error log with rotation
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        format: isProduction
          ? winston.format.combine(winston.format.timestamp(), winston.format.json())
          : winston.format.combine(winston.format.timestamp(), redactFormat),
      })
    )

    // Combined log with rotation
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        format: isProduction
          ? winston.format.combine(winston.format.timestamp(), winston.format.json())
          : winston.format.combine(winston.format.timestamp(), redactFormat),
      })
    )
  } catch (error) {
    console.error('[Logger] Failed to add file transports:', error)
  }
}

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(winston.format.timestamp(), redactFormat),
  transports,
})

// Optional cloud logging adapters (disabled by default)
export function addCloudLoggingAdapter(adapter: winston.transport): void {
  logger.add(adapter)
}

// Export for testing
export { redactSensitiveData, SENSITIVE_PATTERNS }