import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { commitReconciliation, loadProbe, saveProbe, type JournalStorage } from './journal';
import { broadcastProbe, prepareProbe, reconcileProbe, signProbe } from './probe';
import { DEVNET_CHAIN, type PhantomProvider } from './provider';
import { DevnetRpc, encodeMessage, makeTransaction, type ProbeRpc } from './rpc';

const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const blockhash = new PublicKey(new Uint8Array(32).fill(8)).toBase58();

function storage(): JournalStorage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

function rpc(overrides: Partial<ProbeRpc> = {}): ProbeRpc {
  return {
    assertDevnet: async () => {}, latestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    validBlockhash: async () => true, finalizedBlockHeight: async () => 101,
    fee: async () => 5000, balance: async () => 1_000_000, simulate: async () => {},
    transaction: async () => null, recentSignatures: async () => [],
    send: async transaction => bs58.encode(transaction.signature!), ...overrides,
  };
}

function signed(transaction: Transaction): Transaction {
  const result = Transaction.from(transaction.serialize({ verifySignatures: false, requireAllSignatures: false }));
  result.sign(signer);
  return result;
}

function provider(signTransaction: PhantomProvider['signTransaction'] = async transaction => signed(transaction)): PhantomProvider {
  return { isPhantom: true, chain: DEVNET_CHAIN, publicKey: signer.publicKey, assertReady: () => {}, connect: async () => ({ publicKey: signer.publicKey }), signTransaction };
}

test('signature and exact signed bytes are durable before direct devnet submission', async () => {
  const local = storage();
  let calls = 0;
  const client = rpc({ send: async transaction => {
    calls++;
    const stored = loadProbe(local)!;
    assert.equal(stored.signature, bs58.encode(transaction.signature!));
    assert.equal(stored.signedTransaction, transaction.serialize().toString('base64'));
    assert.equal(stored.stage, 'broadcast');
    return stored.signature!;
  } });
  const prepared = await prepareProbe(client, signer.publicKey.toBase58());
  const result = await signProbe(client, provider(), prepared, local);
  assert.equal(calls, 1);
  assert.equal(result.state, 'pending');
  assert.ok(result.signature);
});

test('ambiguous send failure preserves signature and only the same bytes may be rebroadcast', async () => {
  const local = storage();
  const sent: string[] = [];
  let fail = true;
  const client = rpc({ send: async transaction => {
    sent.push(transaction.serialize().toString('base64'));
    if (fail) throw new Error('response lost');
    return bs58.encode(transaction.signature!);
  } });
  const prepared = await prepareProbe(client, signer.publicKey.toBase58());
  await assert.rejects(signProbe(client, provider(), prepared, local), /response lost/);
  const stored = loadProbe(local)!;
  assert.ok(stored.signature);
  assert.equal(stored.detail, 'response lost');
  fail = false;
  const result = await broadcastProbe(client, local, stored.id);
  assert.equal(result.signature, stored.signature);
  assert.deepEqual(sent, [stored.signedTransaction, stored.signedTransaction]);
  await reconcileProbe(client, result);
  assert.equal(sent.length, 2);
});

test('wallet output with a changed blockhash or invalid signature is never sent', async () => {
  for (const altered of [true, false]) {
    const local = storage();
    let calls = 0;
    const client = rpc({ send: async () => { calls++; throw new Error('must not send'); } });
    const prepared = await prepareProbe(client, signer.publicKey.toBase58());
    const wallet = provider(async transaction => {
      const result = signed(transaction);
      if (altered) { result.recentBlockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58(); result.sign(signer); }
      else result.signatures[0]!.signature = Buffer.alloc(64, 1);
      return result;
    });
    await assert.rejects(signProbe(client, wallet, prepared, local), /Отправка заблокирована/);
    assert.equal(calls, 0);
    assert.equal(loadProbe(local)?.signature, undefined);
  }
});

test('failure to persist the signed bytes prevents all broadcast', async () => {
  const local = storage();
  const set = local.setItem;
  local.setItem = (key, value) => {
    if (JSON.parse(value).signedTransaction) throw new Error('quota exceeded');
    set(key, value);
  };
  let calls = 0;
  const client = rpc({ send: async () => { calls++; throw new Error('must not send'); } });
  const prepared = await prepareProbe(client, signer.publicKey.toBase58());
  await assert.rejects(signProbe(client, provider(), prepared, local), /quota exceeded/);
  assert.equal(calls, 0);
  assert.equal(loadProbe(local)?.state, 'pending');
  assert.equal(loadProbe(local)?.signature, undefined);
});

test('fresh blockhash is frozen before wallet signing with the same check identifier', async () => {
  const local = storage();
  const next = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
  const prepared = await prepareProbe(rpc(), signer.publicKey.toBase58());
  const client = rpc({ latestBlockhash: async () => ({ blockhash: next, lastValidBlockHeight: 200 }) });
  const result = await signProbe(client, provider(async transaction => {
    const stored = loadProbe(local)!;
    assert.equal(stored.blockhash, next);
    assert.equal(stored.lastValidBlockHeight, 200);
    assert.equal(stored.id, prepared.probe.id);
    assert.equal(stored.message, encodeMessage(transaction));
    return signed(transaction);
  }), prepared, local);
  assert.equal(result.blockhash, next);
  assert.equal(result.id, prepared.probe.id);
});

test('expired or corrupted signed journal cannot be broadcast', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), signer.publicKey.toBase58());
  await signProbe(rpc(), provider(), prepared, local);
  let calls = 0;
  const client = rpc({ validBlockhash: async () => false, send: async () => { calls++; throw new Error('must not send'); } });
  await assert.rejects(broadcastProbe(client, local, prepared.probe.id), /устарела/);
  assert.match(loadProbe(local)!.detail!, /устарела/);
  await assert.rejects(broadcastProbe(rpc({ assertDevnet: async () => { throw new Error('RPC unavailable'); } }), local, prepared.probe.id), /RPC unavailable/);
  assert.equal(loadProbe(local)?.detail, 'RPC unavailable');
  const current = loadProbe(local)!;
  const changed = signed(makeTransaction(signer.publicKey.toBase58(), blockhash, crypto.randomUUID()));
  saveProbe(local, { ...current, signedTransaction: changed.serialize().toString('base64') });
  await assert.rejects(broadcastProbe(rpc({ send: client.send }), local, prepared.probe.id), /Отправка заблокирована/);
  assert.equal(calls, 0);
});

test('wallet timeout releases the operation and a late signed response never sends', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const local = storage();
  let finish!: (transaction: Transaction) => void;
  let received!: Transaction;
  let notify!: () => void;
  const requested = new Promise<void>(resolve => { notify = resolve; });
  const wallet = provider(transaction => {
    received = transaction;
    notify();
    return new Promise(resolve => { finish = resolve; });
  });
  let calls = 0;
  const client = rpc({ send: async () => { calls++; throw new Error('must not send'); } });
  const prepared = await prepareProbe(client, signer.publicKey.toBase58());
  const signing = signProbe(client, wallet, prepared, local);
  const rejected = assert.rejects(signing, /Phantom не вернул/);
  await requested;
  context.mock.timers.tick(60_001);
  await rejected;
  finish(signed(received));
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(loadProbe(local)?.signature, undefined);
  assert.match(loadProbe(local)!.detail!, /Phantom не вернул/);
});

test('stale unsigned reconciliation preserves signed evidence and stage', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), signer.publicKey.toBase58());
  const result = await signProbe(rpc(), provider(), prepared, local);
  const committed = commitReconciliation(local, { ...prepared.probe, signature: result.signature, state: 'finalized' });
  assert.equal(committed?.signedTransaction, result.signedTransaction);
  assert.equal(committed?.stage, 'broadcast');
  assert.equal(committed?.state, 'finalized');
});

test('RPC error code 4001 is not a wallet rejection', async () => {
  const local = storage();
  const client = rpc({ send: async () => { throw Object.assign(new Error('RPC submission error'), { code: 4001 }); } });
  const prepared = await prepareProbe(client, signer.publicKey.toBase58());
  await assert.rejects(signProbe(client, provider(), prepared, local), /RPC submission error/);
  assert.equal(loadProbe(local)?.state, 'pending');
  assert.ok(loadProbe(local)?.signedTransaction);
  assert.equal(loadProbe(local)?.detail, 'RPC submission error');
});

test('direct RPC submission keeps preflight and a bounded retry count', async context => {
  const transaction = signed(makeTransaction(signer.publicKey.toBase58(), blockhash, crypto.randomUUID()));
  const expected = bs58.encode(transaction.signature!);
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    assert.equal(request.method, 'sendTransaction');
    assert.notEqual(request.params[1].skipPreflight, true);
    assert.equal(request.params[1].preflightCommitment, 'confirmed');
    assert.equal(request.params[1].maxRetries, 5);
    assert.equal(request.params[0], transaction.serialize().toString('base64'));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: expected }));
  });
  assert.equal(await new DevnetRpc().send(transaction), expected);
});
