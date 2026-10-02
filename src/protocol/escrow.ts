import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { sha256, taskHash, taskSchema, unhex, type Task } from './encoding';

export const ESCROW_PROGRAM_ID = new PublicKey('8nxj7c8hn9hhqBE6GrBeNLNEiBJrUHhyFo6wmuxmc7hr');

export function escrowAddress(requester: string, taskId: string): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from('escrow'), new PublicKey(requester).toBuffer(), Buffer.from(unhex(taskId.replaceAll('-', ''))),
  ], ESCROW_PROGRAM_ID)[0];
}

function terms(input: unknown): Task {
  const task = taskSchema.parse(input);
  if (task.escrowProgram !== ESCROW_PROGRAM_ID.toBase58()) throw new Error('Task targets a different escrow deployment');
  return task;
}

function integer(value: number | bigint): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(BigInt(value));
  return output;
}

function hashBytes(hash: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hash) || hash === '0'.repeat(64)) throw new Error('Expected a nonzero SHA-256 commitment');
  return Buffer.from(unhex(hash));
}

async function instruction(name: string, keys: TransactionInstruction['keys'], args: Buffer[] = []) {
  const discriminator = Buffer.from(unhex(await sha256(new TextEncoder().encode(`global:${name}`))).slice(0, 8));
  return new TransactionInstruction({ programId: ESCROW_PROGRAM_ID, keys, data: Buffer.concat([discriminator, ...args]) });
}

function escrow(task: Task) { return { pubkey: escrowAddress(task.requester, task.id), isWritable: true, isSigner: false }; }
function account(address: string, isSigner: boolean, isWritable = false) { return { pubkey: new PublicKey(address), isSigner, isWritable }; }

export async function fundInstruction(input: unknown): Promise<TransactionInstruction> {
  const task = terms(input);
  return instruction('fund', [escrow(task), account(task.requester, true, true), { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], [
    Buffer.from(unhex(task.id.replaceAll('-', ''))), hashBytes(await taskHash(task)),
    new PublicKey(task.executor).toBuffer(), new PublicKey(task.reviewer).toBuffer(), integer(BigInt(task.priceLamports)),
    ...[task.quoteExpiry, task.executionDeadline, task.reviewDeadline, task.resolutionDeadline].map(integer),
  ]);
}

export async function submitReportInstruction(input: unknown, reportHash: string): Promise<TransactionInstruction> {
  const task = terms(input);
  return instruction('submit_report', [escrow(task), account(task.executor, true)], [hashBytes(reportHash)]);
}

export async function acceptInstruction(input: unknown, reportHash: string): Promise<TransactionInstruction> {
  const task = terms(input);
  return instruction('accept_and_release', [escrow(task), account(task.requester, true), account(task.executor, false, true)], [hashBytes(reportHash)]);
}

export async function disputeInstruction(input: unknown, authority: string): Promise<TransactionInstruction> {
  const task = terms(input);
  if (authority !== task.requester && authority !== task.executor) throw new Error('Only requester or executor may open a dispute');
  return instruction('open_dispute', [escrow(task), account(authority, true)]);
}

export async function resolveInstruction(input: unknown, payExecutor: boolean): Promise<TransactionInstruction> {
  const task = terms(input);
  if (typeof payExecutor !== 'boolean') throw new Error('Resolution must pay the executor or refund the requester');
  return instruction('resolve', [escrow(task), account(task.reviewer, true), account(task.requester, false, true), account(task.executor, false, true)], [Buffer.from([Number(payExecutor)])]);
}

export async function refundInstruction(input: unknown): Promise<TransactionInstruction> {
  const task = terms(input);
  return instruction('refund', [escrow(task), account(task.requester, true, true)]);
}
