import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { buildApp, type DemoConfig } from './app';
import { migrate } from './database';
import { Store, type ChainObservation } from './store';
import { startReconciler, type ChainReader } from './chain';
import { reportHash } from '../src/protocol/encoding';

const vector = JSON.parse(await readFile(new URL('../fixtures/protocol-v1.json', import.meta.url), 'utf8'));
const config: DemoConfig = {
  requester: vector.task.requester, executor: vector.task.executor, reviewer: vector.task.reviewer,
  priceLamports: '1000000', requesterToken: randomBytes(32).toString('hex'), capabilitySecret: randomBytes(32).toString('hex'),
};
const container = `field-tests-${randomUUID()}`;
const observations = new Map<string, ChainObservation | null | Error>();
const chain: ChainReader = { async read(task) {
  const value = observations.get(task.id);
  if (value instanceof Error) throw value;
  return value ?? null;
} };
let pool: Pool;
let store: Store;
let app: ReturnType<typeof buildApp>;
let started = false;
const header = (token = config.requesterToken) => ({ authorization: `Bearer ${token}` });
const input = () => ({ idempotencyKey: randomUUID(), cafe: vector.task.cafe });
const create = (payload = input()) => app.inject({ method: 'POST', url: '/v1/tasks', headers: header(), payload });
const get = (id: string, token = config.requesterToken) => app.inject({ url: `/v1/tasks/${id}`, headers: header(token) });
const report = (task: { task: { id: string }; taskHash: string }) => ({ ...structuredClone(vector.report), taskId: task.task.id, taskHash: task.taskHash });
const upload = (id: string, token: string, payload: unknown) => app.inject({ method: 'POST', url: `/v1/tasks/${id}/report`, headers: header(token), payload: payload as object });

before(async () => {
  execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-e', 'POSTGRES_USER=field', '-e', 'POSTGRES_PASSWORD=field_test_only', '-e', 'POSTGRES_DB=field', '-p', '127.0.0.1::5432', 'postgres:18-alpine']);
  started = true;
  const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
  pool = new Pool({ connectionString: `postgresql://field:field_test_only@127.0.0.1:${port}/field`, max: 10, connectionTimeoutMillis: 1000 });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await pool.query('SELECT 1'); ready = true; break; }
    catch { await delay(100); }
  }
  assert.ok(ready, 'The disposable test database must be reachable');
  await migrate(pool);
  await migrate(pool);
  store = new Store(pool);
  app = buildApp({ config, store, chain, now: () => vector.task.issuedAt });
});

after(async () => {
  try { await app?.close(); await pool?.end(); }
  finally { if (started) execFileSync('docker', ['stop', container], { stdio: 'ignore' }); }
});

test('private API rejects missing authorization, foreign hosts and foreign-role creation', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/v1/tasks', payload: input() })).statusCode, 401);
  assert.equal((await app.inject({ url: '/health', headers: { host: 'attacker.example' } })).statusCode, 403);
  const created = (await create()).json();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/tasks', headers: header(created.access.executor), payload: input() })).statusCode, 401);
  assert.equal((await get(created.task.id)).headers['cache-control'], 'no-store');
});

test('concurrent quote retries keep one immutable task and survive changed configuration', async () => {
  const payload = input();
  const responses = await Promise.all(Array.from({ length: 10 }, () => create(payload)));
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), responses[0]!.json());
  }
  const before = responses[0]!.json();
  const restarted = buildApp({ config: { ...config, executor: config.reviewer, reviewer: config.executor, priceLamports: '2000000' }, store, chain, now: () => vector.task.issuedAt + 100_000 });
  try {
    const retried = await restarted.inject({ method: 'POST', url: '/v1/tasks', headers: header(), payload });
    assert.deepEqual(retried.json(), before);
    const changed = await create({ ...payload, cafe: { ...payload.cafe, address: 'Another address' } });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().error.code, 'idempotency_conflict');
  } finally { await restarted.close(); }
});

test('client cannot replace configured price, authorities, commitment or deadlines', async () => {
  for (const extra of [{ priceLamports: '1' }, { requester: config.executor }, { taskHash: '0'.repeat(64) }, { quoteExpiry: 1 }]) {
    assert.equal((await create({ ...input(), ...extra })).statusCode, 400);
  }
  assert.equal((await create({ ...input(), cafe: { name: 'Cafe\u0301', address: 'Address' } })).statusCode, 400);
});

test('invitations are restricted to one task and never expose other invitations', async () => {
  const first = (await create()).json();
  const second = (await create()).json();
  assert.equal((await get(second.task.id, first.access.executor)).statusCode, 401);
  const executor = await get(first.task.id, first.access.executor);
  assert.equal(executor.statusCode, 200);
  assert.equal(executor.json().access, undefined);
  for (const token of [config.requesterToken, first.access.reviewer]) {
    assert.equal((await upload(first.task.id, token, report(first))).statusCode, 403);
  }
});

test('report storage rejects mismatched task, executor, commitment and unattempted criteria', async () => {
  const task = (await create()).json();
  const valid = report(task);
  for (const changed of [
    { ...valid, taskId: randomUUID() }, { ...valid, executor: config.requester }, { ...valid, taskHash: '1'.repeat(64) },
    { ...valid, observations: { ...valid.observations, outlet: { ...valid.observations.outlet, attempted: false } } },
    { ...valid, observations: { ...valid.observations, outlet: { ...valid.observations.outlet, reason: '' } } },
    { ...valid, notes: 'Cafe\u0301' },
  ]) assert.equal((await upload(task.task.id, task.access.executor, changed)).statusCode, 400);
  assert.equal(await store.report(task.task.id), null);
});

test('concurrent report uploads lock exactly one preimage and identical retries are harmless', async () => {
  const task = (await create()).json();
  const reports = [{ ...report(task), notes: 'First report' }, { ...report(task), notes: 'Second report' }];
  const results = await Promise.all(reports.map(body => upload(task.task.id, task.access.executor, body)));
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const stored = results.find(result => result.statusCode === 200)!.json();
  assert.equal(stored.immutable, true);
  assert.equal(stored.executionAvailable, false);
  assert.deepEqual((await upload(task.task.id, task.access.executor, stored.report)).json(), stored);
  const requester = (await get(task.task.id)).json();
  assert.equal(requester.state, 'quoted');
  assert.equal(requester.reportStored, true);
  assert.equal(requester.reportCommitted, false);
  assert.equal(requester.report, null);
  assert.deepEqual((await get(task.task.id, task.access.executor)).json().report, stored.report);
});

test('verified chain evidence binds visibility while stale, missing and conflicting reads never overwrite it', async () => {
  const task = (await create()).json();
  const body = report(task);
  const uploaded = (await upload(task.task.id, task.access.executor, body)).json();
  const hash = await reportHash(body);
  const snapshot = { state: 'submitted' as const, fundedAt: task.task.issuedAt + 1, reportHash: hash };
  observations.set(task.task.id, { slot: 100, snapshot });
  const submitted = (await get(task.task.id)).json();
  assert.equal(submitted.state, 'submitted');
  assert.equal(submitted.reportCommitted, true);
  assert.deepEqual(submitted.report, uploaded.report);
  assert.equal(submitted.chain.slot, '100');
  for (const [observation, expected] of [
    [null, 'not_found'], [new Error('RPC unavailable'), 'unavailable'],
    [{ slot: 99, snapshot: { ...snapshot, state: 'funded', reportHash: null } }, 'stale'],
    [{ slot: 101, snapshot: { ...snapshot, reportHash: '1'.repeat(64) } }, 'conflict'],
    [{ slot: 101, snapshot: { ...snapshot, state: 'funded', reportHash: null } }, 'conflict'],
    [{ slot: 101, snapshot: { ...snapshot, fundedAt: snapshot.fundedAt + 1 } }, 'conflict'],
    [{ slot: 100, snapshot: { ...snapshot, state: 'paid' } }, 'conflict'],
  ] as const) {
    observations.set(task.task.id, observation);
    const result = (await get(task.task.id)).json();
    assert.equal(result.state, 'submitted');
    assert.equal(result.chain.status, expected);
    assert.deepEqual(result.chain.snapshot, submitted.chain.snapshot);
    assert.equal(result.chain.verifiedAt, submitted.chain.verifiedAt);
    assert.equal(result.reportCommitted, false);
    assert.equal(result.report, null);
  }
  observations.set(task.task.id, { slot: 102, snapshot: { ...snapshot, state: 'paid' } });
  assert.equal((await get(task.task.id)).json().state, 'paid');
  observations.set(task.task.id, { slot: 103, snapshot: { ...snapshot, state: 'refunded' } });
  const conflict = (await get(task.task.id)).json();
  assert.equal(conflict.state, 'paid');
  assert.equal(conflict.chain.status, 'conflict');
  assert.ok(!(await store.pending()).some(row => row.id === task.task.id));
});

test('chain hash different from stored content never makes that content a committed report', async () => {
  const task = (await create()).json();
  await upload(task.task.id, task.access.executor, report(task));
  observations.set(task.task.id, { slot: 200, snapshot: { state: 'submitted', fundedAt: task.task.issuedAt + 1, reportHash: '2'.repeat(64) } });
  const result = (await get(task.task.id)).json();
  assert.equal(result.state, 'submitted');
  assert.equal(result.reportStored, true);
  assert.equal(result.reportCommitted, false);
  assert.equal(result.report, null);
});

test('expired quotes remain eligible for discovery of earlier valid funding', async () => {
  const task = (await create()).json();
  assert.ok((await store.pending(100)).some(row => row.id === task.task.id));
  observations.set(task.task.id, { slot: 300, snapshot: { state: 'funded', fundedAt: task.task.issuedAt + 1, reportHash: null } });
  const expiredApp = buildApp({ config, store, chain, now: () => task.task.quoteExpiry + 1 });
  try {
    const result = (await expiredApp.inject({ url: `/v1/tasks/${task.task.id}`, headers: header() })).json();
    assert.equal(result.state, 'funded');
    assert.equal(result.executionAvailable, false);
  } finally { await expiredApp.close(); }
});

test('a delayed older read cannot clear newer contradictory evidence', async () => {
  const task = (await create()).json();
  const body = report(task);
  await upload(task.task.id, task.access.executor, body);
  const snapshot = { state: 'submitted' as const, fundedAt: task.task.issuedAt + 1, reportHash: await reportHash(body) };
  observations.set(task.task.id, { slot: 400, snapshot });
  await get(task.task.id);
  let release: ((value: ChainObservation) => void) | undefined;
  let begun: (() => void) | undefined;
  const started = new Promise<void>(resolve => { begun = resolve; });
  let calls = 0;
  const racing = buildApp({ config, store, now: () => vector.task.issuedAt, chain: {
    read: async () => {
      if (++calls === 1) return new Promise<ChainObservation>(resolve => { release = resolve; begun!(); });
      return { slot: 401, snapshot: { ...snapshot, reportHash: '3'.repeat(64) } };
    },
  } });
  try {
    const delayed = racing.inject({ url: `/v1/tasks/${task.task.id}`, headers: header() }).then(response => response.json());
    await started;
    const conflict = (await racing.inject({ url: `/v1/tasks/${task.task.id}`, headers: header() })).json();
    assert.equal(conflict.chain.status, 'conflict');
    assert.equal(conflict.chain.seenSlot, '401');
    release!({ slot: 400, snapshot });
    const older = await delayed;
    assert.equal(older.reportCommitted, false);
    assert.equal(older.chain.status, 'conflict');
    assert.equal(older.chain.slot, '400');
    assert.equal(older.chain.seenSlot, '401');
    observations.set(task.task.id, { slot: 401, snapshot });
    assert.equal((await get(task.task.id)).json().reportCommitted, false);
    observations.set(task.task.id, { slot: 402, snapshot });
    assert.equal((await get(task.task.id)).json().reportCommitted, true);
  } finally { release?.({ slot: 400, snapshot }); await racing.close(); }
});

test('account absence retains its newer context and cannot be undone by an older response', async () => {
  const task = (await create()).json();
  const snapshot = { state: 'funded' as const, fundedAt: task.task.issuedAt + 1, reportHash: null };
  observations.set(task.task.id, { slot: 500, snapshot });
  await get(task.task.id);
  observations.set(task.task.id, { slot: 501, snapshot: null });
  const absent = (await get(task.task.id)).json();
  assert.equal(absent.state, 'funded');
  assert.equal(absent.chain.status, 'not_found');
  assert.equal(absent.chain.seenSlot, '501');
  for (const slot of [500, 501]) {
    observations.set(task.task.id, { slot, snapshot });
    assert.notEqual((await get(task.task.id)).json().chain.status, 'verified');
  }
  observations.set(task.task.id, { slot: 502, snapshot });
  assert.equal((await get(task.task.id)).json().chain.status, 'verified');
});

test('a terminal no-report refund cannot acquire a report commitment later', async () => {
  const task = (await create()).json();
  const snapshot = { state: 'refunded' as const, fundedAt: task.task.issuedAt + 1, reportHash: null };
  observations.set(task.task.id, { slot: 600, snapshot });
  await get(task.task.id);
  observations.set(task.task.id, { slot: 601, snapshot: { ...snapshot, reportHash: '4'.repeat(64) } });
  const result = (await get(task.task.id)).json();
  assert.equal(result.state, 'refunded');
  assert.equal(result.chain.status, 'conflict');
  assert.equal(result.chain.snapshot.reportHash, null);
});

test('periodic reconciliation never overlaps and shutdown waits for its active read', async () => {
  let release: ((value: null) => void) | undefined;
  let calls = 0;
  const slow: ChainReader = { read: async () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const stop = startReconciler(store, slow, error => { throw error; }, 1);
  try {
    for (let i = 0; !release && i < 100; i++) await delay(10);
    assert.ok(release);
    await delay(10);
    assert.equal(calls, 1);
  } finally {
    const stopped = stop();
    release?.(null);
    await stopped;
  }
  await delay(10);
  assert.equal(calls, 1);
});
