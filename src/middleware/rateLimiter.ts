import rateLimit from 'express-rate-limit'
import { config } from '../config/env'

export const rateLimiter = rateLimit({
  windowMs: config.security.rateLimit.windowMs,
  max: config.security.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again later.'
  }
})

export const authRateLimiter = rateLimit({
  windowMs: config.security.authRateLimit.windowMs,
  max: config.security.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts. Please try again in 15 minutes.'
  }
})

// Stricter rate limit for admin endpoints (10 requests per 15 minutes)
export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many admin requests. Please try again later.'
  },
  skip: () => process.env.NODE_ENV === 'test',
})