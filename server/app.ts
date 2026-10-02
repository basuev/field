import Fastify from 'fastify';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { reportHash, taskHash, taskSchema, validateReportForTask, type Task } from '../src/protocol/encoding';
import { ESCROW_PROGRAM_ID } from '../src/protocol/escrow';
import { reconcile, type ChainReader } from './chain';
import { ApiError, Store, type TaskRow } from './store';

export interface DemoConfig {
  requester: string;
  executor: string;
  reviewer: string;
  priceLamports: string;
  requesterToken: string;
  capabilitySecret: string;
}

type Role = 'requester' | 'executor' | 'reviewer';
const idSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const quoteSchema = z.strictObject({ idempotencyKey: idSchema, cafe: taskSchema.shape.cafe });

export function capability(config: DemoConfig, id: string, role: 'executor' | 'reviewer'): string {
  return createHmac('sha256', Buffer.from(config.capabilitySecret, 'hex')).update(`Field/capability/v1\0${role}\0${id}`).digest('hex');
}

function matches(input: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(input)) return false;
  return timingSafeEqual(Buffer.from(input, 'hex'), Buffer.from(expected, 'hex'));
}

function quote(config: DemoConfig, cafe: Task['cafe'], now: number): Task {
  return taskSchema.parse({
    schemaVersion: 1, id: randomUUID(), kind: 'cafe-laptop-check', network: 'solana:devnet',
    escrowProgram: ESCROW_PROGRAM_ID.toBase58(), cafe,
    requester: config.requester, executor: config.executor, reviewer: config.reviewer, priceLamports: config.priceLamports,
    issuedAt: now, quoteExpiry: now + 900, executionDeadline: now + 7200,
    reviewDeadline: now + 10_800, resolutionDeadline: now + 86_400,
  });
}

export function buildApp(options: { config: DemoConfig; store: Store; chain: ChainReader; now?: () => number; logger?: boolean }) {
  const { config, store, chain } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  if (![config.requesterToken, config.capabilitySecret].every(secret => /^[0-9a-f]{64}$/.test(secret))) throw new Error('Server credentials must be generated 32-byte hexadecimal secrets');
  if (config.requesterToken === config.capabilitySecret) throw new Error('Use separate requester and capability secrets');
  quote(config, { name: 'Configuration validation', address: 'Local configuration only' }, now());
  const app = Fastify({ bodyLimit: 65_536, logger: options.logger ? { redact: ['req.headers.authorization'] } : false });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host}`).hostname; }
    catch { throw new ApiError(403, 'host_not_allowed', 'Use the local server address'); }
    if (!['localhost', '127.0.0.1'].includes(hostname)) throw new ApiError(403, 'host_not_allowed', 'Use the local server address');
  });

  function authorize(header: string | undefined, id?: string): Role {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (matches(token, config.requesterToken)) return 'requester';
    if (id) {
      for (const role of ['executor', 'reviewer'] as const) if (matches(token, capability(config, id, role))) return role;
    }
    throw new ApiError(401, 'unauthorized', 'A role credential is required');
  }

  async function view(row: TaskRow, role: Role) {
    const report = await store.report(row.id);
    const committed = Boolean(report && row.chain_status === 'verified' && row.chain_snapshot?.reportHash === report.report_hash);
    return {
      task: row.task, taskHash: row.task_hash, state: row.state, executionAvailable: false,
      chain: { status: row.chain_status, slot: row.chain_slot, seenSlot: row.chain_seen_slot, checkedAt: row.chain_checked_at, verifiedAt: row.chain_verified_at, snapshot: row.chain_snapshot },
      reportStored: Boolean(report), reportCommitted: committed,
      report: role === 'executor' || committed ? report?.content ?? null : null,
    };
  }

  app.get('/health', async () => ({ status: 'ok', network: 'solana:devnet', executionAvailable: false }));

  app.post('/v1/tasks', async request => {
    authorize(request.headers.authorization);
    const input = quoteSchema.parse(request.body);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.cafe.name, input.cafe.address])).digest('hex');
    const row = await store.quote(input.idempotencyKey, fingerprint, async () => {
      const task = quote(config, input.cafe, now());
      return { task, hash: await taskHash(task) };
    });
    return { ...await view(row, 'requester'), access: { executor: capability(config, row.id, 'executor'), reviewer: capability(config, row.id, 'reviewer') } };
  });

  app.get<{ Params: { id: string } }>('/v1/tasks/:id', async request => {
    const id = idSchema.parse(request.params.id);
    const role = authorize(request.headers.authorization, id);
    const row = await reconcile(store, chain, await store.task(id));
    return view(row, role);
  });

  app.post<{ Params: { id: string } }>('/v1/tasks/:id/report', async request => {
    const id = idSchema.parse(request.params.id);
    if (authorize(request.headers.authorization, id) !== 'executor') throw new ApiError(403, 'wrong_role', 'Only the executor invitation may lock a report');
    const row = await store.task(id);
    let report;
    try { report = await validateReportForTask(request.body, row.task); }
    catch { throw new ApiError(400, 'invalid_report', 'Report does not match the task and inspection requirements'); }
    const stored = await store.storeReport(id, report, await reportHash(report));
    return { report: stored.content, reportHash: stored.report_hash, immutable: true, executionAvailable: false };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: 'Request does not match the schema' } });
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status < 500) return reply.code(status).send({ error: { code: 'invalid_request', message: 'Invalid HTTP request' } });
    app.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Request failed' } });
  });
  return app;
}
