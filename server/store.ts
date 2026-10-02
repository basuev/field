import type { Pool } from 'pg';
import type { Report, Task } from '../src/protocol/encoding';
import type { EscrowSnapshot } from '../src/protocol/state';
import { transaction } from './database';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export interface TaskRow {
  id: string;
  request_fingerprint: string;
  task: Task;
  task_hash: string;
  state: 'quoted' | EscrowSnapshot['state'];
  chain_snapshot: EscrowSnapshot | null;
  chain_slot: string | null;
  chain_seen_slot: string | null;
  chain_checked_at: Date | null;
  chain_verified_at: Date | null;
  chain_status: 'unchecked' | 'verified' | 'not_found' | 'unavailable' | 'conflict' | 'stale';
}

export interface ReportRow { content: Report; report_hash: string; }
export interface ChainObservation { slot: number; snapshot: EscrowSnapshot | null; }

const successors: Record<TaskRow['state'], readonly TaskRow['state'][]> = {
  quoted: ['funded', 'submitted', 'disputed', 'paid', 'refunded'],
  funded: ['submitted', 'disputed', 'paid', 'refunded'],
  submitted: ['disputed', 'paid', 'refunded'], disputed: ['paid', 'refunded'], paid: [], refunded: [],
};

export class Store {
  constructor(private readonly pool: Pool) {}

  async quote(key: string, fingerprint: string, create: () => Promise<{ task: Task; hash: string }>): Promise<TaskRow> {
    return transaction(this.pool, async client => {
      const previous = await client.query<TaskRow>('SELECT * FROM tasks WHERE idempotency_key = $1', [key]);
      if (previous.rows[0]) {
        if (previous.rows[0].request_fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This key belongs to another request');
        return previous.rows[0];
      }
      const { task, hash } = await create();
      await client.query('INSERT INTO tasks (id, idempotency_key, request_fingerprint, task, task_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (idempotency_key) DO NOTHING', [task.id, key, fingerprint, task, hash]);
      const result = (await client.query<TaskRow>('SELECT * FROM tasks WHERE idempotency_key = $1', [key])).rows[0]!;
      if (result.request_fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This key belongs to another request');
      return result;
    });
  }

  async task(id: string): Promise<TaskRow> {
    const row = (await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
    if (!row) throw new ApiError(404, 'not_found', 'Task not found');
    return row;
  }

  async report(id: string): Promise<ReportRow | null> {
    return (await this.pool.query<ReportRow>('SELECT content, report_hash FROM reports WHERE task_id = $1', [id])).rows[0] ?? null;
  }

  async storeReport(id: string, content: Report, hash: string): Promise<ReportRow> {
    return transaction(this.pool, async client => {
      await client.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [id]);
      const previous = (await client.query<ReportRow>('SELECT content, report_hash FROM reports WHERE task_id = $1', [id])).rows[0];
      if (previous) {
        if (previous.report_hash !== hash) throw new ApiError(409, 'report_locked', 'A different immutable report is already stored');
        return previous;
      }
      await client.query('INSERT INTO reports (task_id, content, report_hash) VALUES ($1, $2, $3)', [id, content, hash]);
      return { content, report_hash: hash };
    });
  }

  async observe(id: string, observation: ChainObservation | null, available = true): Promise<TaskRow> {
    return transaction(this.pool, async client => {
      const row = (await client.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!row) throw new ApiError(404, 'not_found', 'Task not found');
      let status: TaskRow['chain_status'] = available ? 'not_found' : 'unavailable';
      if (observation) {
        if (!Number.isSafeInteger(observation.slot) || observation.slot < 0) throw new Error('Invalid RPC context slot');
        const slot = BigInt(observation.slot);
        const previous = row.chain_snapshot;
        const seen = row.chain_seen_slot === null ? null : BigInt(row.chain_seen_slot);
        if (seen !== null && slot < seen) status = row.chain_status === 'conflict' ? 'conflict' : 'stale';
        else if (observation.snapshot) {
          const snapshot = observation.snapshot;
          if ((seen !== null && slot === seen && row.chain_slot !== row.chain_seen_slot)
            || (row.state !== snapshot.state && !successors[row.state].includes(snapshot.state))
            || (previous && (previous.reportHash !== null || ['paid', 'refunded'].includes(previous.state)) && previous.reportHash !== snapshot.reportHash)
            || (previous && previous.fundedAt !== snapshot.fundedAt)
            || (previous && row.chain_slot !== null && slot === BigInt(row.chain_slot)
              && (previous.state !== snapshot.state || previous.reportHash !== snapshot.reportHash))) status = 'conflict';
          else {
            return (await client.query<TaskRow>('UPDATE tasks SET state = $2, chain_snapshot = $3, chain_slot = $4, chain_seen_slot = $4, chain_checked_at = now(), chain_verified_at = now(), chain_status = $5 WHERE id = $1 RETURNING *', [id, snapshot.state, snapshot, String(slot), 'verified'])).rows[0]!;
          }
        }
      }
      return (await client.query<TaskRow>('UPDATE tasks SET chain_checked_at = now(), chain_status = $2, chain_seen_slot = GREATEST(chain_seen_slot, $3::bigint) WHERE id = $1 RETURNING *', [id, status, observation ? String(observation.slot) : null])).rows[0]!;
    });
  }

  async pending(limit = 20): Promise<TaskRow[]> {
    return (await this.pool.query<TaskRow>('SELECT * FROM tasks WHERE state NOT IN ($1, $2) ORDER BY chain_checked_at NULLS FIRST, id LIMIT $3', ['paid', 'refunded', limit])).rows;
  }
}
