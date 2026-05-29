import express, { Request, Response } from 'express'
import { validateRequest, twiml } from 'twilio'
import { handleWhatsAppMessage } from '../whatsapp/handler'
import { config } from '../config/env'
import { logger } from '../utils/logger'

const router = express.Router()

/**
 * Health check for Twilio webhook
 */
router.get('/webhook', (_req: Request, res: Response) => {
  res.status(200).send('WhatsApp webhook is alive')
})

/**
 * Handles incoming WhatsApp messages from Twilio
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
router.post('/webhook', async (req: Request, res: Response) => {
  const signature = req.header('x-twilio-signature')
  const authToken = process.env.TWILIO_AUTH_TOKEN || ''

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`

  if (!signature || !authToken) {
    return res.status(403).send('Forbidden')
  }

  const isValid = validateRequest(authToken, signature, url, req.body)
  if (!isValid && config.nodeEnv === 'production') {
    return res.status(403).send('Forbidden')
  }

  const from = (req.body.From as string) || ''
  const body = (req.body.Body as string) || ''

  try {
    const response = await handleWhatsAppMessage(from, body)
    const responseTwiml = new twiml.MessagingResponse()
    responseTwiml.message(response.body)
    res.type('text/xml').send(responseTwiml.toString())
  } catch (error) {
    logger.error('[WhatsApp webhook] error handling message:', error)
    const errorTwiml = new twiml.MessagingResponse()
    errorTwiml.message('Sorry, something went wrong processing your request.')
    res.type('text/xml').send(errorTwiml.toString())
  }
})

export default router
