import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { prepareTaskOperation, signTaskOperation, checkTaskOperation, broadcastTaskOperation, loadTaskOperations, type TaskRpc } from './task';
import type { PhantomProvider } from './provider';
import type { JournalStorage } from './journal';
import type { EscrowSnapshot } from '../protocol/state';

const vector = JSON.parse(await readFile(new URL('../../fixtures/protocol-v1.json', import.meta.url), 'utf8'));
const signer = Keypair.generate();
const task = { ...vector.task, requester: signer.publicKey.toBase58(), executor: Keypair.generate().publicKey.toBase58(), reviewer: Keypair.generate().publicKey.toBase58() };
const blockhash = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
function storage(): JournalStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
function rpc(): TaskRpc {
  return {
    assertDevnet: async () => {}, verifyProgram: async () => {},
    latestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 500 }), validBlockhash: async () => true,
    finalizedBlockHeight: async () => 100, balance: async () => 10_000_000, fee: async () => 5000,
    simulate: async () => {}, transaction: async () => null, recentSignatures: async () => [],
    send: async tx => bs58.encode(tx.signature!), escrow: async () => null,
    clock: async () => task.issuedAt + 1, rent: async () => 2_000_000,
  };
}
function provider(sign: (tx: Transaction) => Promise<Transaction> = async tx => { tx.partialSign(signer); return tx; }): PhantomProvider {
  return { isPhantom: true, chain: 'solana:devnet', publicKey: signer.publicKey, assertReady() {}, connect: async () => ({ publicKey: signer.publicKey }), signTransaction: sign };
}

test('task signatures and exact bytes are persisted before any direct submission', async () => {
  const chain = rpc();
  const memory = storage();
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  let sent = false;
  chain.send = async tx => {
    const [saved] = await loadTaskOperations(memory);
    assert.equal(saved!.signature, bs58.encode(tx.signature!));
    assert.equal(saved!.signedTransaction, tx.serialize().toString('base64'));
    assert.equal(saved!.stage, 'broadcast');
    assert.equal(tx.instructions.length, 3);
    assert.equal(tx.instructions[0]!.data.readUInt32LE(1), 200_000);
    assert.equal(tx.instructions[1]!.data.readBigUInt64LE(1), 0n);
    sent = true;
    return saved!.signature!;
  };
  const result = await signTaskOperation(chain, provider(), prepared, memory);
  assert.equal(sent, true);
  assert.equal(result.state, 'pending');
});

test('canonical task edits and modified wallet output never reach submission', async () => {
  const chain = rpc();
  const memory = storage();
  let sent = 0;
  chain.send = async () => { sent++; throw new Error('Must not send'); };
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  await assert.rejects(signTaskOperation(chain, provider(), { ...prepared, task: { ...task, priceLamports: '2' } }, memory), /canonical task/);
  const bad = provider(async tx => { tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); tx.partialSign(signer); return tx; });
  const result = await signTaskOperation(chain, bad, prepared, memory);
  assert.equal(result.state, 'pending');
  assert.ok(result.walletResponse);
  assert.equal(result.signature, undefined);
  assert.equal(sent, 0);
  await assert.rejects(signTaskOperation(chain, provider(), prepared, memory), /existing pending/);
});

test('an ambiguous RPC error remains pending and retries reuse identical signed bytes', async () => {
  const chain = rpc();
  const memory = storage();
  const bytes: string[] = [];
  chain.send = async tx => { bytes.push(tx.serialize().toString('base64')); throw Object.assign(new Error('RPC response lost'), { code: 4001 }); };
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  const result = await signTaskOperation(chain, provider(), prepared, memory);
  assert.equal(result.state, 'pending');
  assert.ok(result.signature);
  await broadcastTaskOperation(chain, memory, result.id);
  assert.equal(bytes.length, 2);
  assert.equal(bytes[0], bytes[1]);
  chain.validBlockhash = async () => false;
  const expired = await broadcastTaskOperation(chain, memory, result.id);
  assert.equal(expired.state, 'pending');
  assert.equal(bytes.length, 2);
  assert.match((await loadTaskOperations(memory))[0]!.detail!, /unknown/);
});

test('only explicit wallet rejection is terminal without a submitted signature', async () => {
  const chain = rpc();
  const memory = storage();
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  const result = await signTaskOperation(chain, provider(async () => { throw { code: 4001 }; }), prepared, memory);
  assert.equal(result.state, 'rejected');
  assert.equal(result.signature, undefined);
});

test('failed durable storage prevents requesting the wallet signature', async () => {
  const chain = rpc();
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  let asked = false;
  const broken: JournalStorage = { getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); }, removeItem() {} };
  await assert.rejects(signTaskOperation(chain, provider(async tx => { asked = true; return tx; }), prepared, broken), /Storage unavailable/);
  assert.equal(asked, false);
});

test('finalized exact message and valid signature establish execution, not a wallet callback', async () => {
  const chain = rpc();
  const memory = storage();
  const prepared = await prepareTaskOperation(chain, task, 'fund', null);
  const pending = await signTaskOperation(chain, provider(), prepared, memory);
  chain.transaction = async () => ({ message: pending.message, err: null });
  const finalized = await checkTaskOperation(chain, memory, pending.id);
  assert.equal(finalized.state, 'finalized');
  assert.equal(finalized.signature, pending.signature);
});

test('existing escrow, wrong program, insufficient balance and wrong acceptance hash block preparation', async () => {
  const chain = rpc();
  chain.verifyProgram = async () => { throw new Error('Wrong program'); };
  await assert.rejects(prepareTaskOperation(chain, task, 'fund', null), /Wrong program/);
  chain.verifyProgram = async () => {};
  chain.balance = async () => 1;
  await assert.rejects(prepareTaskOperation(chain, task, 'fund', null), /Insufficient/);
  chain.balance = async () => 10_000_000;
  let state: EscrowSnapshot = { state: 'funded', fundedAt: task.issuedAt + 1, reportHash: null };
  chain.escrow = async () => state;
  await assert.rejects(prepareTaskOperation(chain, task, 'fund', null), /already exists/);
  state = { ...state, state: 'submitted', reportHash: '1'.repeat(64) };
  await assert.rejects(prepareTaskOperation(chain, task, 'accept', '2'.repeat(64)), /commitment/);
});
