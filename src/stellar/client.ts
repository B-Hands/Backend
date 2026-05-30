import {
  rpc,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { TransactionResult } from './types';

export function resolveNetworkPassphrase(network: string | undefined): string {
  switch (network?.toLowerCase()) {
    case 'mainnet':
      return Networks.PUBLIC;
    case 'testnet':
      return Networks.TESTNET;
    case 'futurenet':
      return Networks.FUTURENET;
    default:
      throw new Error(
        `Unknown STELLAR_NETWORK: "${network}". Expected "mainnet", "testnet", or "futurenet".`
      );
  }
}

const RPC_URL = config.stellar.rpcUrl;
const NETWORK_PASSPHRASE = resolveNetworkPassphrase(config.stellar.network);

let agentKeypair: Keypair | null = null;
let rpcServer: rpc.Server | null = null;

/**
 * Initialize RPC server connection
 */
export function getRpcServer(): rpc.Server {
  if (!rpcServer) {
    rpcServer = new rpc.Server(RPC_URL);
  }
  return rpcServer;
}

/**
 * Get network passphrase
 */
export function getNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE;
}

/**
 * Load agent keypair from environment
 */
export function getAgentKeypair(): Keypair {
  if (!agentKeypair) {
    const secret = process.env.STELLAR_AGENT_SECRET_KEY;
    if (!secret) {
      throw new Error('STELLAR_AGENT_SECRET_KEY not configured');
    }
    agentKeypair = Keypair.fromSecret(secret);
  }
  return agentKeypair;
}

/**
 * Submit transaction to Stellar network
 */
export async function submitTransaction(tx: Transaction): Promise<string> {
  const server = getRpcServer();
  
  try {
    const response = await server.sendTransaction(tx);
    
    if (response.status === 'ERROR') {
      throw new Error(`Transaction failed: ${response.errorResult?.toXDR('base64')}`);
    }
    
    return response.hash;
  } catch (error) {
    throw new Error(`Failed to submit transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Wait for transaction confirmation
 */
export async function waitForConfirmation(
  txHash: string,
  timeoutMs: number = 30000
): Promise<TransactionResult> {
  const server = getRpcServer();
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await server.getTransaction(txHash);
      
      if (response.status === 'SUCCESS') {
        return {
          hash: txHash,
          status: 'success',
          ledger: response.ledger,
        };
      }
      
      if (response.status === 'FAILED') {
        return {
          hash: txHash,
          status: 'failed',
        };
      }
      
      // Still pending, wait before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      throw new Error(`Error polling transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  throw new Error(`Transaction confirmation timeout after ${timeoutMs}ms`);
}
