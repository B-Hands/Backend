import { parseIntent } from '../nlp/parser'
import {
  normalizePhone,
  createOrGetUser,
  generateOtp,
  verifyOtp,
  getBalance,
  getUserWalletAddress,
  getPortfolioYieldSummary,
  decrementBalance,
} from './userManager'
import db from '../db'

export type WhatsAppResponse = {
  body: string
}

function formatHelpMessage(): string {
  return [
    'Welcome to NeuroWealth! Here are some things you can ask me:',
    '- "balance" → check your wallet balance',
    '- "deposit <amount>" → get deposit instructions',
    '- "withdraw <amount>" → withdraw funds (if available)',
    '- "earnings" → see your performance',
    '- "set up recurring deposit 50 weekly" → start automatic deposits',
    '- "pause recurring deposit" → pause your scheduled deposits',
    '- "help" → show this message again',
  ].join('\n')
}

function formatOtpMessage(code: string): string {
  return `Welcome to NeuroWealth! Your verification code is: ${code}\n\nReply with the 6-digit code to activate your account.`
}

function formatBalanceMessage(balance: number, address: string): string {
  return `Your current balance is ${balance.toFixed(2)} XLM.\nWallet: ${address}`
}

function formatDepositInstruction(amount: number, address: string): string {
  return `To deposit, send ${amount.toFixed(2)} XLM to your wallet address:\n${address}\n\nOnce the transaction is confirmed, reply "balance" to see your updated balance.`
}

function formatWithdrawConfirmation(
  amount: number,
  newBalance: number
): string {
  return `Withdrawal request received for ${amount.toFixed(2)} XLM.\nYour new balance will be ${newBalance.toFixed(2)} XLM once processed.`
}

function formatInsufficientFunds(balance: number, requested: number): string {
  return `You only have ${balance.toFixed(2)} XLM available, but you requested ${requested.toFixed(2)} XLM.\nTry a smaller amount or deposit more funds.`
}

function formatEarnings(input: {
  totalBalance: number
  totalEarnings: number
  periodEarnings: number
  averageApy: number
}): string {
  return [
    `Your portfolio balance is ${input.totalBalance.toFixed(2)} XLM equivalent.`,
    `Total earnings to date: ${input.totalEarnings.toFixed(2)} XLM.`,
    `Earnings over the last 30 days: ${input.periodEarnings.toFixed(2)} XLM.`,
    `Average APY across your tracked positions: ${(input.averageApy * 100).toFixed(2)}%.`,
  ].join('\n')
}

function formatUnknownMessage(): string {
  return `Sorry, I didn't understand that.\n${formatHelpMessage()}`
}

function extractOtpCode(message: string): string | null {
  const match = message.match(/\b(\d{6})\b/)
  return match ? match[1] : null
}

export async function handleWhatsAppMessage(
  from: string,
  message: string
): Promise<WhatsAppResponse> {
  const normalizedPhone = normalizePhone(from)
  const user = await createOrGetUser(normalizedPhone)

  // If user is not verified, treat any 6-digit code as an OTP attempt.
  if (!user.verified) {
    const codeFromMessage = extractOtpCode(message)
    if (codeFromMessage) {
      const success = verifyOtp(normalizedPhone, codeFromMessage)
      if (success) {
        const wallet = getUserWalletAddress(normalizedPhone)
        return {
          body: `✅ Your account is now verified!\nYour wallet address is: ${wallet}\n\n${formatHelpMessage()}`,
        }
      }

      return {
        body: 'Invalid or expired OTP. Please request a new code by sending any message.',
      }
    }

    // Send OTP for new user or re-send if not verified
    const otp = generateOtp(normalizedPhone)
    return { body: formatOtpMessage(otp) }
  }

  const intent = await parseIntent(message)

  switch (intent.action) {
    case 'balance': {
      const balance = getBalance(normalizedPhone) ?? 0
      const address = getUserWalletAddress(normalizedPhone) ?? 'unknown'
      return { body: formatBalanceMessage(balance, address) }
    }

    case 'deposit': {
      const amount = intent.amount
      if (!amount || amount <= 0) {
        return { body: 'Please specify a deposit amount, e.g. "deposit 10".' }
      }
      const address = getUserWalletAddress(normalizedPhone)
      return { body: formatDepositInstruction(amount, address ?? 'unknown') }
    }

    case 'withdraw': {
      const balance = getBalance(normalizedPhone) ?? 0
      const amount = intent.all ? balance : intent.amount
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify a withdrawal amount, e.g. "withdraw 5" or "withdraw all".',
        }
      }
      if (amount > balance) {
        return { body: formatInsufficientFunds(balance, amount) }
      }
      const newBalance = decrementBalance(normalizedPhone, amount)
      return { body: formatWithdrawConfirmation(amount, newBalance) }
    }

    case 'help':
      return { body: formatHelpMessage() }

    case 'earnings': {
      const summary = await getPortfolioYieldSummary(normalizedPhone)
      if (!summary) {
        return {
          body: 'I could not find any tracked portfolio data for your account yet.',
        }
      }

      return { body: formatEarnings(summary) }
    }

    case 'create_recurring_deposit': {
      const amount = intent.amount
      const cadence = intent.cadence
      if (!amount || amount <= 0) {
        return {
          body: 'Please specify an amount, e.g. "recurring deposit 50 weekly".',
        }
      }
      if (!cadence) {
        return {
          body: 'Please specify a schedule: weekly, biweekly, or monthly.',
        }
      }
      const wallet = getUserWalletAddress(normalizedPhone)
      if (!wallet) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const user = await db.user.findFirst({
        where: { walletAddress: wallet },
        select: { id: true },
      })
      if (!user) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const nextRunAt = new Date()
      switch (cadence) {
        case 'WEEKLY':
          nextRunAt.setDate(nextRunAt.getDate() + 7)
          break
        case 'BIWEEKLY':
          nextRunAt.setDate(nextRunAt.getDate() + 14)
          break
        case 'MONTHLY':
          nextRunAt.setMonth(nextRunAt.getMonth() + 1)
          break
      }
      const plan = await db.recurringDepositPlan.create({
        data: {
          userId: user.id,
          amount,
          assetSymbol: 'USDC',
          cadence,
          nextRunAt,
        },
      })
      return {
        body: [
          '✅ *Recurring deposit created*',
          `Amount: *${amount} USDC*`,
          `Schedule: *${cadence}*`,
          `First run: _${nextRunAt.toLocaleDateString()}_`,
          '_Your deposits will run automatically on schedule._',
        ].join('\n'),
      }
    }

    case 'pause_recurring_deposit': {
      const wallet = getUserWalletAddress(normalizedPhone)
      if (!wallet) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const user = await db.user.findFirst({
        where: { walletAddress: wallet },
        select: { id: true },
      })
      if (!user) {
        return { body: 'Your account is not fully set up yet.' }
      }
      const activePlans = await db.recurringDepositPlan.findMany({
        where: { userId: user.id, status: 'ACTIVE' },
      })
      if (activePlans.length === 0) {
        return { body: 'You have no active recurring deposits to pause.' }
      }
      await db.recurringDepositPlan.updateMany({
        where: { userId: user.id, status: 'ACTIVE' },
        data: { status: 'PAUSED' },
      })
      return {
        body: `✅ *${activePlans.length} recurring deposit(s) paused*\nYou can resume them anytime with "resume recurring deposit".`,
      }
    }

    case 'unknown':
    default:
      return { body: formatUnknownMessage() }
  }
}
