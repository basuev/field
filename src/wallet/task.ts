import { ComputeBudgetProgram, Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { z } from 'zod';
import { taskSchema, type Task } from '../protocol/encoding';
import { acceptInstruction, escrowAddress, fundInstruction, refundInstruction, submitReportInstruction } from '../protocol/escrow';
import { ESCROW_ACCOUNT_SIZE, verifyEscrowAccount, type EscrowSnapshot } from '../protocol/state';
import { verifyDeployment } from '../protocol/deployment';
import approvedProgram from '../protocol/approved-program.json';
import { DEVNET_RPC } from './config';
import { loadProbe, type JournalStorage } from './journal';
import { isRejection, type PhantomProvider } from './provider';
import { DevnetRpc, encodeMessage, type ProbeRpc } from './rpc';

const KEY = 'field.task-operations.v1';
const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const opSchema = z.strictObject({
  id: z.uuid(), task: taskSchema, action: z.enum(['fund', 'report', 'accept', 'refund']),
  reportHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  wallet: z.string().min(32).max(44).regex(base58),
  blockhash: z.string().min(32).max(44).regex(base58), lastValidBlockHeight: z.number().int().nonnegative(),
  message: z.string().min(1).max(2400).regex(base64),
  feeLamports: z.number().int().nonnegative(), rentLamports: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(), state: z.enum(['pending', 'finalized', 'failed', 'rejected']),
  stage: z.enum(['wallet', 'signed', 'broadcast']),
  signature: z.string().min(64).max(88).regex(base58).optional(),
  signedTransaction: z.string().min(1).max(2400).regex(base64).optional(),
  walletResponse: z.string().min(1).max(2400).regex(base64).optional(), detail: z.string().max(500).optional(),
}).refine(op => (!op.signedTransaction || Boolean(op.signature)) && (op.state !== 'finalized' || Boolean(op.signature)));
const journalSchema = z.strictObject({ version: z.literal(1), operations: z.array(opSchema).max(100) })
  .refine(journal => new Set(journal.operations.map(op => op.id)).size === journal.operations.length);
export type TaskOperation = z.infer<typeof opSchema>;
export type TaskAction = TaskOperation['action'];

export interface TaskRpc extends ProbeRpc {
  verifyProgram(): Promise<void>;
  escrow(task: Task): Promise<EscrowSnapshot | null>;
  clock(): Promise<number>;
  rent(): Promise<number>;
}

export class DevnetTaskRpc extends DevnetRpc implements TaskRpc {
  private readonly accounts = new Connection(DEVNET_RPC, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  async verifyProgram() { await verifyDeployment(this.accounts, approvedProgram); }
  async escrow(task: Task) {
    const address = escrowAddress(task.requester, task.id);
    const account = await this.accounts.getAccountInfo(address, 'finalized');
    return account ? verifyEscrowAccount(task, { ...account, address }) : null;
  }
  async clock() {
    const account = await this.accounts.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'finalized');
    if (!account || account.data.length !== 40) throw new Error('Solana clock is unavailable');
    const time = account.data.readBigInt64LE(32);
    if (time < 0n || time > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Solana clock');
    return Number(time);
  }
  rent() { return this.accounts.getMinimumBalanceForRentExemption(ESCROW_ACCOUNT_SIZE, 'finalized'); }
}

async function transaction(op: Pick<TaskOperation, 'task' | 'action' | 'reportHash' | 'wallet' | 'blockhash'>): Promise<Transaction> {
  const wallet = op.action === 'report' ? op.task.executor : op.task.requester;
  if (wallet !== op.wallet) throw new Error('The signer differs from the fixed task authority');
  if ((op.action === 'report' || op.action === 'accept') && (!op.reportHash || op.reportHash === '0'.repeat(64))) throw new Error('A nonempty report commitment is required');
  if ((op.action === 'fund' || op.action === 'refund') && op.reportHash !== null) throw new Error('Unexpected report commitment');
  const instruction = op.action === 'fund' ? await fundInstruction(op.task)
    : op.action === 'report' ? await submitReportInstruction(op.task, op.reportHash!)
      : op.action === 'accept' ? await acceptInstruction(op.task, op.reportHash!) : await refundInstruction(op.task);
  return new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash: op.blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), instruction,
  );
}

async function validate(op: TaskOperation): Promise<void> {
  opSchema.parse(op);
  if (encodeMessage(await transaction(op)) !== op.message) throw new Error('Saved transaction does not match its canonical task');
  if (op.signedTransaction) validateSigned(op, Transaction.from(Buffer.from(op.signedTransaction, 'base64')));
}

function validateSigned(op: TaskOperation, signed: Transaction): string {
  if (encodeMessage(signed) !== op.message || signed.signatures.length !== 1
    || signed.signatures[0]?.publicKey.toBase58() !== op.wallet || !signed.signature || !signed.verifySignatures(true)) {
    throw new Error('Wallet output differs from the approved transaction. Nothing was broadcast by Field');
  }
  const signature = bs58.encode(signed.signature);
  if (op.signature && signature !== op.signature) throw new Error('Saved signature does not match the signed transaction');
  return signature;
}

function read(storage: JournalStorage): TaskOperation[] {
  const raw = storage.getItem(KEY);
  if (raw === null) return [];
  try { return journalSchema.parse(JSON.parse(raw)).operations; }
  catch { throw new Error('The task journal is corrupted. Do not sign another payment'); }
}

export async function loadTaskOperations(storage: JournalStorage): Promise<TaskOperation[]> {
  const operations = read(storage);
  for (const op of operations) await validate(op);
  return operations;
}

function save(storage: JournalStorage, op: TaskOperation) {
  const operations = read(storage);
  const index = operations.findIndex(item => item.id === op.id);
  if (index < 0) operations.push(op); else operations[index] = op;
  storage.setItem(KEY, JSON.stringify(journalSchema.parse({ version: 1, operations })));
}

function pending(storage: JournalStorage, id: string): TaskOperation {
  const op = read(storage).find(item => item.id === id);
  if (!op || op.state !== 'pending') throw new Error('This operation is no longer pending');
  return op;
}

async function eligible(rpc: TaskRpc, op: Pick<TaskOperation, 'task' | 'action' | 'reportHash'>) {
  const [state, time] = await Promise.all([rpc.escrow(op.task), rpc.clock()]);
  if (op.action === 'fund') {
    if (state || time < op.task.issuedAt || time >= op.task.quoteExpiry) throw new Error('Task already exists or its quote has expired');
  } else if (op.action === 'report') {
    if (state?.state !== 'funded' || time >= op.task.executionDeadline) throw new Error('Task is not awaiting an executor report');
  } else if (op.action === 'accept') {
    if (state?.state !== 'submitted' || state.reportHash !== op.reportHash || time >= op.task.reviewDeadline) throw new Error('Report commitment or acceptance deadline does not match');
  } else if (!state || !['funded', 'submitted', 'disputed'].includes(state.state)
    || (time < op.task.resolutionDeadline && !(state.state === 'funded' && time >= op.task.executionDeadline))) {
    throw new Error('The agreed refund condition has not been reached');
  }
}

export async function prepareTaskOperation(rpc: TaskRpc, taskInput: unknown, action: TaskAction, reportHash: string | null): Promise<TaskOperation> {
  const task = taskSchema.parse(taskInput);
  await rpc.assertDevnet();
  await rpc.verifyProgram();
  await eligible(rpc, { task, action, reportHash });
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const wallet = action === 'report' ? task.executor : task.requester;
  const tx = await transaction({ task, action, reportHash, wallet, blockhash });
  const [feeLamports, balance, rentLamports] = await Promise.all([rpc.fee(tx), rpc.balance(wallet), action === 'fund' ? rpc.rent() : 0]);
  if (feeLamports === null || !Number.isSafeInteger(feeLamports) || feeLamports < 0
    || !Number.isSafeInteger(balance) || balance < 0 || !Number.isSafeInteger(rentLamports) || rentLamports < 0) throw new Error('A safe fee, rent and balance estimate is required');
  const needed = BigInt(feeLamports) + (action === 'fund' ? BigInt(task.priceLamports) + BigInt(rentLamports) : 0n);
  if (BigInt(balance) < needed) throw new Error('Insufficient test SOL for the approved amount, rent and network fee');
  await rpc.simulate(tx);
  return opSchema.parse({ id: crypto.randomUUID(), task, action, reportHash, wallet, blockhash, lastValidBlockHeight,
    message: encodeMessage(tx), feeLamports, rentLamports, createdAt: new Date().toISOString(), state: 'pending', stage: 'wallet' });
}

export async function signTaskOperation(rpc: TaskRpc, provider: PhantomProvider, prepared: TaskOperation, storage: JournalStorage): Promise<TaskOperation> {
  await validate(prepared);
  if ((await loadTaskOperations(storage)).some(op => op.state === 'pending') || loadProbe(storage)?.state === 'pending') throw new Error('Resolve the existing pending operation before signing another one');
  provider.assertReady();
  if (provider.publicKey?.toBase58() !== prepared.wallet) throw new Error('Connect the fixed task signer');
  await rpc.assertDevnet();
  await rpc.verifyProgram();
  await eligible(rpc, prepared);
  const validity = await rpc.latestBlockhash();
  const refreshed = { ...prepared, ...validity };
  const tx = await transaction(refreshed);
  refreshed.message = encodeMessage(tx);
  const [fee, balance, rent] = await Promise.all([rpc.fee(tx), rpc.balance(prepared.wallet), prepared.action === 'fund' ? rpc.rent() : 0]);
  if (fee !== prepared.feeLamports || rent !== prepared.rentLamports || !Number.isSafeInteger(balance)
    || BigInt(balance) < BigInt(prepared.feeLamports) + (prepared.action === 'fund' ? BigInt(prepared.task.priceLamports) + BigInt(prepared.rentLamports) : 0n)) throw new Error('Fee or balance changed. Prepare a new preview');
  await rpc.simulate(tx);
  provider.assertReady();
  if (provider.publicKey?.toBase58() !== prepared.wallet) throw new Error('Wallet account changed before signing');
  save(storage, refreshed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signed: Transaction;
  try {
    signed = await Promise.race([
      provider.signTransaction(tx),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Wallet response timed out. Check the existing operation, do not sign again')), 60_000); }),
    ]);
  } catch (error) {
    const current = pending(storage, prepared.id);
    const result: TaskOperation = { ...current, state: isRejection(error) ? 'rejected' : 'pending', detail: error instanceof Error ? error.message.slice(0, 500) : 'Wallet response unavailable' };
    save(storage, result);
    return result;
  } finally { clearTimeout(timer); }
  const current = pending(storage, prepared.id);
  try {
    const walletResponse = signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    save(storage, { ...current, walletResponse });
    const signature = validateSigned(current, signed);
    const result: TaskOperation = { ...current, signature, signedTransaction: signed.serialize().toString('base64'), walletResponse, stage: 'signed' };
    save(storage, result);
  } catch (error) {
    const result = { ...pending(storage, prepared.id), detail: error instanceof Error ? error.message.slice(0, 500) : 'Signed bytes could not be saved' };
    save(storage, result);
    return result;
  }
  return broadcastTaskOperation(rpc, storage, prepared.id);
}

export async function checkTaskOperation(rpc: TaskRpc, storage: JournalStorage, id: string): Promise<TaskOperation> {
  const op = read(storage).find(item => item.id === id);
  if (!op) throw new Error('Operation not found');
  await validate(op);
  if (op.state !== 'pending') return op;
  await rpc.assertDevnet();
  const signatures = op.signature ? [op.signature] : await rpc.recentSignatures(op.wallet);
  for (const signature of signatures) {
    const result = await rpc.transaction(signature);
    if (!result) continue;
    if (result.message !== op.message) {
      if (op.signature) throw new Error('Finalized transaction does not match the saved operation');
      continue;
    }
    const recovered = Transaction.from(Buffer.concat([Buffer.from([1]), Buffer.from(bs58.decode(signature)), Buffer.from(op.message, 'base64')]));
    validateSigned(op, recovered);
    const current = pending(storage, id);
    const updated: TaskOperation = { ...current, signature, signedTransaction: recovered.serialize().toString('base64'),
      state: result.err === null ? 'finalized' : 'failed', detail: result.err === null ? undefined : 'Solana finalized this transaction with an execution error. Its network fee may have been charged' };
    save(storage, updated);
    return updated;
  }
  return pending(storage, id);
}

export async function broadcastTaskOperation(rpc: TaskRpc, storage: JournalStorage, id: string): Promise<TaskOperation> {
  const current = await checkTaskOperation(rpc, storage, id);
  if (current.state !== 'pending' || !current.signedTransaction) return current;
  await rpc.assertDevnet();
  await rpc.verifyProgram();
  if (!await rpc.validBlockhash(current.blockhash)) {
    const expired = { ...pending(storage, id), detail: 'Saved blockhash has expired. Outcome is still unknown. Do not sign a replacement' };
    save(storage, expired);
    return expired;
  }
  const tx = Transaction.from(Buffer.from(current.signedTransaction, 'base64'));
  validateSigned(current, tx);
  save(storage, { ...pending(storage, id), stage: 'broadcast' });
  try {
    const signature = await rpc.send(tx);
    if (signature !== current.signature) throw new Error('RPC returned an unexpected signature');
    return pending(storage, id);
  } catch (error) {
    const result = { ...pending(storage, id), detail: error instanceof Error ? error.message.slice(0, 500) : 'Broadcast response unavailable. Check the saved signature' };
    save(storage, result);
    return result;
  }
}
