import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { DEVNET_GENESIS, browseLink, explorerLink, JOURNAL_KEY } from './config';
import { clearProbe, commitReconciliation, loadProbe, saveProbe, type JournalStorage } from './journal';
import { abandonProbe, broadcastProbe, prepareProbe, reconcileProbe, signProbe } from './probe';
import type { PhantomProvider } from './provider';
import { DevnetRpc, encodeMessage, makeTransaction, type ProbeRpc } from './rpc';

const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const wallet = signer.publicKey;
const blockhash = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
const signature = '3'.repeat(87);

function storage(): JournalStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  };
}

function rpc(overrides: Partial<ProbeRpc> = {}): ProbeRpc {
  return {
    assertDevnet: async () => {},
    latestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    validBlockhash: async () => true,
    finalizedBlockHeight: async () => 101,
    balance: async () => 1_000_000,
    fee: async () => 5000,
    simulate: async () => {},
    transaction: async () => null,
    recentSignatures: async () => [],
    send: async transaction => bs58.encode(transaction.signature!),
    ...overrides,
  };
}

function provider(sign: () => Promise<{ signature: string }>): Omit<PhantomProvider, 'publicKey'> & { publicKey: PublicKey | null } {
  return {
    isPhantom: true, chain: 'solana:devnet', assertReady: () => {}, publicKey: wallet, connect: async () => ({ publicKey: wallet }),
    signTransaction: async transaction => {
      await sign();
      const signed = Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
      signed.sign(signer);
      return signed;
    },
  };
}

test('browse link encodes HTTPS URL and drops query and fragment', () => {
  const link = new URL(browseLink('https://field.example/check?token=private#secret'));
  assert.equal(decodeURIComponent(link.pathname.replace('/ul/browse/', '')), 'https://field.example/check');
  assert.equal(link.searchParams.get('ref'), 'https://field.example');
  assert.throws(() => browseLink('http://192.168.1.2:5173'), /HTTPS/);
  assert.throws(() => browseLink('https://user:pass@field.example'), /учётные/);
  assert.match(explorerLink(signature), /cluster=devnet/);
});

test('probe transaction contains explicit compute budget and a memo with the wallet signer', () => {
  const transaction = makeTransaction(wallet.toBase58(), blockhash, crypto.randomUUID());
  assert.equal(transaction.instructions.length, 3);
  assert.equal(transaction.feePayer?.toBase58(), wallet.toBase58());
  assert.equal(transaction.instructions[2]?.keys[0]?.isSigner, true);
  assert.match(transaction.instructions[2]!.data.toString(), /^Field wallet check v2 /);
});

test('preparation checks devnet before requesting a blockhash', async () => {
  let requested = false;
  const client = rpc({
    assertDevnet: async () => { throw new Error('wrong chain'); },
    latestBlockhash: async () => { requested = true; return { blockhash, lastValidBlockHeight: 100 }; },
  });
  await assert.rejects(prepareProbe(client, wallet.toBase58()), /wrong chain/);
  assert.equal(requested, false);
});

test('missing fee estimate and insufficient balance block preparation', async () => {
  await assert.rejects(prepareProbe(rpc({ fee: async () => null }), wallet.toBase58()), /комиссию/);
  await assert.rejects(prepareProbe(rpc({ balance: async () => 4999 }), wallet.toBase58()), /Недостаточно/);
});

test('failed devnet simulation prevents preparation', async () => {
  await assert.rejects(prepareProbe(rpc({ simulate: async () => { throw new Error('simulation failed'); } }), wallet.toBase58()), /simulation failed/);
});

test('legacy pending journals retain their original transaction format', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const legacy = { ...prepared.probe, version: 1 as const, message: encodeMessage(makeTransaction(wallet.toBase58(), blockhash, prepared.probe.id, 1)) };
  const local = storage();
  saveProbe(local, legacy);
  const result = await reconcileProbe(rpc({ transaction: async () => ({ err: null, message: legacy.message }) }), { ...loadProbe(local)!, signature });
  assert.equal(result.version, 1);
  assert.equal(result.state, 'finalized');
});

test('journal is saved before calling the wallet', async () => {
  const local = storage();
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  const result = await signProbe(client, provider(async () => {
    assert.equal(loadProbe(local)?.state, 'pending');
    assert.equal(loadProbe(local)?.id, prepared.probe.id);
    return { signature };
  }), prepared, local);
  assert.equal(result.stage, 'broadcast');
  assert.equal(result.state, 'pending');
  assert.ok(result.signedTransaction);
  assert.equal(loadProbe(local)?.signature, result.signature);
});

test('storage failure blocks signing', async () => {
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  let called = false;
  const local = storage();
  local.setItem = () => { throw new Error('storage unavailable'); };
  await assert.rejects(signProbe(client, provider(async () => {
    called = true; return { signature };
  }), prepared, local), /storage unavailable/);
  assert.equal(called, false);
});

test('duplicate signing is blocked for both pending and completed checks', async () => {
  const local = storage();
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  let calls = 0;
  const phantom = provider(async () => { calls += 1; return { signature }; });
  await signProbe(client, phantom, prepared, local);
  await assert.rejects(signProbe(client, phantom, prepared, local), /предыдущую/);
  saveProbe(local, { ...prepared.probe, signature, state: 'finalized' });
  await assert.rejects(signProbe(client, phantom, prepared, local), /предыдущую/);
  assert.equal(calls, 1);
});

test('lost wallet response remains pending and cannot be cleared', async () => {
  const local = storage();
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  await assert.rejects(signProbe(client, provider(async () => { throw new Error('connection lost'); }), prepared, local), /connection lost/);
  assert.equal(loadProbe(local)?.state, 'pending');
  assert.equal(loadProbe(local)?.signature, undefined);
  assert.throws(() => clearProbe(local), /незавершённой/);
});

test('explicit wallet rejection is terminal and can be cleared', async () => {
  const local = storage();
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  const result = await signProbe(client, provider(async () => { throw { code: 4001 }; }), prepared, local);
  assert.equal(result.state, 'rejected');
  clearProbe(local);
  assert.equal(loadProbe(local), null);
});

test('changed wallet or transaction blocks signing', async () => {
  const client = rpc();
  const prepared = await prepareProbe(client, wallet.toBase58());
  const phantom = provider(async () => { throw new Error('must not sign'); });
  phantom.publicKey = new PublicKey(new Uint8Array(32).fill(9));
  await assert.rejects(signProbe(client, phantom, prepared, storage()), /Кошелёк изменился/);
  prepared.transaction.add(new TransactionInstruction({ programId: wallet, keys: [], data: Buffer.alloc(0) }));
  await assert.rejects(signProbe(client, provider(async () => { throw new Error('must not sign'); }), prepared, storage()), /изменена/);
});

test('chain is checked again immediately before signing', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const local = storage();
  await assert.rejects(signProbe(
    rpc({ assertDevnet: async () => { throw new Error('wrong chain'); } }),
    provider(async () => { throw new Error('must not sign'); }), prepared, local,
  ), /wrong chain/);
  assert.equal(loadProbe(local), null);
});

test('finalized matching message is required for success', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const result = await reconcileProbe(rpc({
    transaction: async () => ({ err: null, message: prepared.probe.message }),
  }), { ...prepared.probe, signature });
  assert.equal(result.state, 'finalized');
});

test('expired preview never reaches storage or the wallet', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const local = storage();
  let called = false;
  await assert.rejects(signProbe(
    rpc({ validBlockhash: async () => false }),
    provider(async () => { called = true; return { signature }; }), prepared, local,
  ), /устарела/);
  assert.equal(called, false);
  assert.equal(loadProbe(local), null);
});

test('account change during the network check blocks signing', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const local = storage();
  const phantom = provider(async () => { throw new Error('must not sign'); });
  await assert.rejects(signProbe(rpc({
    assertDevnet: async () => { phantom.publicKey = new PublicKey(new Uint8Array(32).fill(9)); },
  }), phantom, prepared, local), /Кошелёк изменился/);
  assert.equal(loadProbe(local), null);
});

test('stale reconciliation never regresses or overwrites a newer journal', async () => {
  const local = storage();
  const first = (await prepareProbe(rpc(), wallet.toBase58())).probe;
  const second = (await prepareProbe(rpc(), wallet.toBase58())).probe;
  const completed = { ...first, signature, state: 'finalized' as const };
  saveProbe(local, first);
  assert.equal(commitReconciliation(local, completed)?.state, 'finalized');
  assert.equal(commitReconciliation(local, first)?.state, 'finalized');
  clearProbe(local);
  saveProbe(local, second);
  assert.equal(commitReconciliation(local, completed)?.id, second.id);
  assert.equal(loadProbe(local)?.state, 'pending');
});

test('missing finalized transaction data remains pending', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const result = await reconcileProbe(rpc(), { ...prepared.probe, signature });
  assert.equal(result.state, 'pending');
});

test('unrelated signature never proves success', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  await assert.rejects(reconcileProbe(rpc({
    transaction: async () => ({ err: null, message: 'unrelated' }),
  }), { ...prepared.probe, signature }), /другую транзакцию/);
});

test('finalized execution error is not success', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const result = await reconcileProbe(rpc({
    transaction: async () => ({ err: { InstructionError: [0, 'InvalidInstructionData'] }, message: prepared.probe.message }),
  }), { ...prepared.probe, signature });
  assert.equal(result.state, 'failed');
});

test('lost response can be recovered by the exact finalized transaction message', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const result = await reconcileProbe(rpc({
    recentSignatures: async () => ['2'.repeat(87), signature],
    transaction: async candidate => ({ err: null, message: candidate === signature ? prepared.probe.message : 'different' }),
  }), prepared.probe);
  assert.equal(result.state, 'finalized');
  assert.equal(result.signature, signature);
});

test('inconclusive search remains pending even after blockhash expiry', async () => {
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const result = await reconcileProbe(rpc(), { ...prepared.probe, lastValidBlockHeight: 0 });
  assert.equal(result.state, 'pending');
});

test('manual abandonment requires explicit acknowledgement and no received signature', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, prepared.probe);
  await assert.rejects(abandonProbe(rpc(), local, prepared.probe.id, false), /согласие/);
  saveProbe(local, { ...prepared.probe, signature });
  await assert.rejects(abandonProbe(rpc(), local, prepared.probe.id, true), /без полученной подписи/);
  assert.equal(loadProbe(local)?.state, 'pending');
});

test('manual abandonment blocks a valid blockhash or nonfinalized expiry', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, prepared.probe);
  await assert.rejects(abandonProbe(rpc(), local, prepared.probe.id, true), /ещё может быть исполнена/);
  await assert.rejects(abandonProbe(rpc({ validBlockhash: async () => false, finalizedBlockHeight: async () => 100 }), local, prepared.probe.id, true), /ещё может быть исполнена/);
  assert.equal(loadProbe(local)?.state, 'pending');
});

test('manual abandonment stores original pending record and consent atomically', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  const original = { ...prepared.probe, version: 1 as const, message: encodeMessage(makeTransaction(wallet.toBase58(), blockhash, prepared.probe.id, 1)) };
  saveProbe(local, original);
  const result = await abandonProbe(rpc({ validBlockhash: async () => false }), local, original.id, true);
  assert.equal(result.state, 'abandoned');
  const stored = JSON.parse(local.getItem(JOURNAL_KEY)!);
  assert.deepEqual(stored.archive[0].original, original);
  assert.equal(stored.archive[0].outcomeUnknownAcknowledged, true);
  assert.equal(stored.archive[0].walletPromptsClosed, true);
  assert.equal(stored.archive[0].finalizedBlockHeight, 101);
  clearProbe(local);
  assert.equal(loadProbe(local), null);
  const next = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, next.probe);
  assert.equal(JSON.parse(local.getItem(JOURNAL_KEY)!).archive[0].original.id, original.id);
  assert.equal(loadProbe(local)?.id, next.probe.id);
  assert.notEqual(next.probe.id, original.id);
});

test('RPC or archive write failure leaves the original check pending', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, prepared.probe);
  await assert.rejects(abandonProbe(rpc({ finalizedBlockHeight: async () => { throw new Error('RPC unavailable'); } }), local, prepared.probe.id, true), /RPC unavailable/);
  assert.equal(loadProbe(local)?.state, 'pending');
  const before = local.getItem(JOURNAL_KEY);
  local.setItem = () => { throw new Error('quota exceeded'); };
  await assert.rejects(abandonProbe(rpc({ validBlockhash: async () => false }), local, prepared.probe.id, true), /quota exceeded/);
  assert.equal(local.getItem(JOURNAL_KEY), before);
});

test('manual abandonment discovers a finalized transaction before archiving', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, prepared.probe);
  const result = await abandonProbe(rpc({
    validBlockhash: async () => false,
    recentSignatures: async () => [signature],
    transaction: async () => ({ err: null, message: prepared.probe.message }),
  }), local, prepared.probe.id, true);
  assert.equal(result.state, 'finalized');
  assert.equal(JSON.parse(local.getItem(JOURNAL_KEY)!).archive, undefined);
});

test('late reconciliation never overwrites manual abandonment', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  saveProbe(local, prepared.probe);
  await abandonProbe(rpc({ validBlockhash: async () => false }), local, prepared.probe.id, true);
  assert.equal(commitReconciliation(local, { ...prepared.probe, signature, state: 'finalized' })?.state, 'abandoned');
  assert.equal(loadProbe(local)?.state, 'abandoned');
});

for (const outcome of ['success', 'rejection'] as const) {
  test(`late wallet ${outcome} never changes the replacement check`, async () => {
    const local = storage();
    const prepared = await prepareProbe(rpc(), wallet.toBase58());
    let notifySaved!: () => void;
    const saved = new Promise<void>(resolve => { notifySaved = resolve; });
    let finish!: (result: { signature: string }) => void;
    let reject!: (error: unknown) => void;
    const response = new Promise<{ signature: string }>((resolve, rejectResponse) => { finish = resolve; reject = rejectResponse; });
    const signing = signProbe(rpc(), provider(() => response), prepared, local, notifySaved);
    await saved;
    await abandonProbe(rpc({ validBlockhash: async () => false }), local, prepared.probe.id, true);
    clearProbe(local);
    const replacement = await prepareProbe(rpc(), wallet.toBase58());
    saveProbe(local, replacement.probe);
    if (outcome === 'success') {
      finish({ signature });
      await assert.rejects(signing, /проверка изменилась/);
    } else {
      reject({ code: 4001 });
      await assert.rejects(signing, error => typeof error === 'object' && error !== null && 'code' in error && error.code === 4001);
    }
    assert.equal(loadProbe(local)?.id, replacement.probe.id);
    assert.equal(loadProbe(local)?.state, 'pending');
    assert.equal(JSON.parse(local.getItem(JOURNAL_KEY)!).archive[0].original.id, prepared.probe.id);
  });
}

test('tampered abandonment without its archive blocks reading and reset', async () => {
  const local = storage();
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  local.setItem(JOURNAL_KEY, JSON.stringify({ ...prepared.probe, state: 'abandoned' }));
  assert.throws(() => loadProbe(local), /повреждены/);
  assert.throws(() => clearProbe(local), /повреждены/);
});

test('corrupt or modified journal is rejected without being discarded', async () => {
  const local = storage();
  local.setItem(JOURNAL_KEY, '{broken');
  assert.throws(() => loadProbe(local), /повреждены/);
  assert.equal(local.getItem(JOURNAL_KEY), '{broken');
  const prepared = await prepareProbe(rpc(), wallet.toBase58());
  assert.throws(() => saveProbe(local, prepared.probe), /повреждены/);
  const modified = storage();
  saveProbe(modified, { ...prepared.probe, message: 'AAAA' });
  await assert.rejects(reconcileProbe(rpc(), loadProbe(modified)!), /не совпадает/);
});

test('RPC adapter verifies the actual genesis hash with bounded requests', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.signal);
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: DEVNET_GENESIS }));
    };
    await new DevnetRpc().assertDevnet();
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'mainnet-genesis' }));
    };
    await assert.rejects(new DevnetRpc().assertDevnet(), /не к Solana devnet/);
  } finally { globalThis.fetch = originalFetch; }
});
