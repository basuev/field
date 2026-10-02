import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { DEVNET_GENESIS, DEVNET_RPC, MEMO_PROGRAM } from './config';
import type { Probe } from './journal';

export interface ChainTransaction {
  message: string;
  err: unknown;
}

export interface ProbeRpc {
  assertDevnet(): Promise<void>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  validBlockhash(blockhash: string): Promise<boolean>;
  finalizedBlockHeight(): Promise<number>;
  balance(wallet: string): Promise<number>;
  fee(transaction: Transaction): Promise<number | null>;
  simulate(transaction: Transaction): Promise<void>;
  transaction(signature: string): Promise<ChainTransaction | null>;
  recentSignatures(wallet: string): Promise<string[]>;
  send(transaction: Transaction): Promise<string>;
}

export class DevnetRpc implements ProbeRpc {
  private readonly connection = new Connection(DEVNET_RPC, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });

  async assertDevnet(): Promise<void> {
    if (await this.connection.getGenesisHash() !== DEVNET_GENESIS) {
      throw new Error('RPC подключён не к Solana devnet. Подписание заблокировано.');
    }
  }

  latestBlockhash() {
    return this.connection.getLatestBlockhash('finalized');
  }

  async validBlockhash(blockhash: string) {
    return (await this.connection.isBlockhashValid(blockhash, { commitment: 'finalized' })).value;
  }

  finalizedBlockHeight() {
    return this.connection.getBlockHeight('finalized');
  }

  balance(wallet: string) {
    return this.connection.getBalance(new PublicKey(wallet), 'finalized');
  }

  async fee(transaction: Transaction) {
    return (await this.connection.getFeeForMessage(transaction.compileMessage(), 'finalized')).value;
  }

  async simulate(transaction: Transaction): Promise<void> {
    const result = await this.connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {
      sigVerify: false, commitment: 'confirmed',
    });
    if (result.value.err !== null) {
      throw new Error(`Симуляция в Solana devnet не прошла. Подписание заблокировано. ${JSON.stringify(result.value.err)}`);
    }
  }

  async transaction(signature: string): Promise<ChainTransaction | null> {
    const result = await this.connection.getTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!result) return null;
    if (!result.meta) throw new Error('RPC не вернул результат выполнения транзакции.');
    return {
      message: Buffer.from(result.transaction.message.serialize()).toString('base64'),
      err: result.meta.err,
    };
  }

  send(transaction: Transaction) {
    return this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5,
    });
  }

  async recentSignatures(wallet: string) {
    const results = await this.connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 20 }, 'finalized');
    return results.map(result => result.signature);
  }
}

export function validateSignedTransaction(probe: Probe, transaction: Transaction): string {
  validateProbe(probe);
  if (encodeMessage(transaction) !== probe.message || transaction.signatures.length !== 1
    || transaction.signatures[0]?.publicKey.toBase58() !== probe.wallet
    || !transaction.verifySignatures(true) || !transaction.signature) {
    throw new Error('Подписанная транзакция не совпадает с проверкой или подпись недействительна. Отправка заблокирована.');
  }
  const signature = bs58.encode(transaction.signature);
  if (probe.signature && probe.signature !== signature) {
    throw new Error('Сохранённая подпись не совпадает с подписанной транзакцией. Отправка заблокирована.');
  }
  return signature;
}

export function memoText(id: string, version: 1 | 2 = 2): string {
  return `Field wallet check v${version} ${id}`;
}

export function makeTransaction(wallet: string, blockhash: string, id: string, version: 1 | 2 = 2): Transaction {
  const transaction = new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash: blockhash });
  if (version === 2) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
    );
  }
  return transaction.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM),
      keys: [{ pubkey: new PublicKey(wallet), isSigner: true, isWritable: false }],
      data: Buffer.from(memoText(id, version), 'utf8'),
    }),
  );
}

export function encodeMessage(transaction: Transaction): string {
  return Buffer.from(transaction.serializeMessage()).toString('base64');
}

export function validateProbe(probe: Probe): void {
  const expected = makeTransaction(probe.wallet, probe.blockhash, probe.id, probe.version);
  if (encodeMessage(expected) !== probe.message) {
    throw new Error('Сохранённая транзакция не совпадает с проверкой кошелька.');
  }
}
