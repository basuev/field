import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { hex, taskHash, taskSchema, unhex } from './encoding';
import { ESCROW_PROGRAM_ID } from './escrow';

export const ESCROW_ACCOUNT_SIZE = 235;
const STATES = ['funded', 'submitted', 'disputed', 'paid', 'refunded'] as const;

export interface EscrowAccount {
  address: PublicKey;
  owner: PublicKey;
  executable: boolean;
  data: Uint8Array;
}

export interface EscrowSnapshot {
  state: typeof STATES[number];
  fundedAt: number;
  reportHash: string | null;
}

export async function verifyEscrowAccount(taskInput: unknown, account: EscrowAccount): Promise<EscrowSnapshot> {
  const task = taskSchema.parse(taskInput);
  if (task.escrowProgram !== ESCROW_PROGRAM_ID.toBase58() || !account.owner.equals(ESCROW_PROGRAM_ID) || account.executable) {
    throw new Error('Escrow account does not belong to the approved program');
  }
  const [address, bump] = PublicKey.findProgramAddressSync([
    Buffer.from('escrow'), new PublicKey(task.requester).toBuffer(), Buffer.from(unhex(task.id.replaceAll('-', ''))),
  ], ESCROW_PROGRAM_ID);
  if (!address.equals(account.address) || account.data.length !== ESCROW_ACCOUNT_SIZE) throw new Error('Escrow address or account size does not match the task');
  const data = Buffer.from(account.data);
  const discriminator = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('account:Escrow'))).slice(0, 8);
  if (!data.subarray(0, 8).equals(Buffer.from(discriminator))) throw new Error('Invalid escrow account discriminator');
  let offset = 8;
  const bytes = (length: number) => { const result = data.subarray(offset, offset + length); offset += length; return result; };
  const byte = () => bytes(1)[0]!;
  const timestamp = () => {
    const value = bytes(8).readBigInt64LE();
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid escrow timestamp');
    return Number(value);
  };
  if (byte() !== 1 || hex(bytes(16)) !== task.id.replaceAll('-', '') || hex(bytes(32)) !== await taskHash(task)) {
    throw new Error('Escrow task commitment does not match');
  }
  for (const expected of [task.requester, task.executor, task.reviewer]) {
    if (new PublicKey(bytes(32)).toBase58() !== expected) throw new Error('Escrow authority does not match the task');
  }
  if (bytes(8).readBigUInt64LE().toString() !== task.priceLamports) throw new Error('Escrow price does not match the task');
  for (const expected of [task.quoteExpiry, task.executionDeadline, task.reviewDeadline, task.resolutionDeadline]) {
    if (timestamp() !== expected) throw new Error('Escrow deadline does not match the task');
  }
  const fundedAt = timestamp();
  if (fundedAt < task.issuedAt || fundedAt >= task.quoteExpiry) throw new Error('Escrow funding time is outside the approved quote');
  const reportHash = hex(bytes(32));
  const state = STATES[byte()];
  if (!state || byte() !== bump || offset !== data.length) throw new Error('Invalid escrow state or derived address bump');
  const noReport = reportHash === '0'.repeat(64);
  if ((state === 'funded' && !noReport) || (['submitted', 'disputed', 'paid'].includes(state) && noReport)) {
    throw new Error('Escrow report commitment is inconsistent with its state');
  }
  return { state, fundedAt, reportHash: noReport ? null : reportHash };
}
