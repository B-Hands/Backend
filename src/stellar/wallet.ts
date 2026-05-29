import { Keypair } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): string {
  const key = process.env.WALLET_ENCRYPTION_KEY || '';
  if (!key || key.length !== 64) {
    throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return key;
}

interface CustodialWallet {
  userId: string;
  publicKey: string;
  encryptedSecret: string;
  iv: string;
  authTag: string;
}

// In-memory storage (replace with database in production)
const walletStore = new Map<string, CustodialWallet>();

/**
 * Encrypt secret key
 * SECURITY: Never log secret keys. Use environment-based encryption key.
 */
function encryptSecret(secret: string): { encrypted: string; iv: string; authTag: string } {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt secret key
 */
function decryptSecret(encrypted: string, iv: string, authTag: string): string {
  const key = Buffer.from(getEncryptionKey(), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Create custodial wallet for user
 *
 * SECURITY NOTE: This is a custodial solution where the backend holds user keys.
 * Users trust the backend to secure their funds. Consider non-custodial alternatives
 * for production use cases requiring higher security guarantees.
 */
export async function createCustodialWallet(userId: string): Promise<CustodialWallet> {
  if (walletStore.has(userId)) {
    throw new Error(`Wallet already exists for user ${userId}`);
  }

  const keypair = Keypair.random();
  const { encrypted, iv, authTag } = encryptSecret(keypair.secret());

  const wallet: CustodialWallet = {
    userId,
    publicKey: keypair.publicKey(),
    encryptedSecret: encrypted,
    iv,
    authTag,
  };

  walletStore.set(userId, wallet);

  logger.info(`[Wallet] Created for user ${userId}: ${wallet.publicKey}`);

  return wallet;
}

/**
 * Get wallet by user ID
 */
export async function getWalletByUserId(userId: string): Promise<CustodialWallet | null> {
  return walletStore.get(userId) || null;
}

/**
 * Get keypair for user (decrypts secret)
 */
export async function getKeypairForUser(userId: string): Promise<Keypair> {
  const wallet = await getWalletByUserId(userId);

  if (!wallet) {
    throw new Error(`No wallet found for user ${userId}`);
  }

  const secret = decryptSecret(wallet.encryptedSecret, wallet.iv, wallet.authTag);
  return Keypair.fromSecret(secret);
}

/**
 * List all wallet public keys (for admin/debugging)
 */
export function listWallets(): string[] {
  return Array.from(walletStore.values()).map(w => w.publicKey);
}