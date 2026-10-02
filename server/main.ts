import { Pool } from 'pg';
import { z } from 'zod';
import { buildApp } from './app';
import { DevnetChainReader, startReconciler } from './chain';
import { migrate } from './database';
import { Store } from './store';

const env = z.object({
  FIELD_DATABASE_URL: z.string().min(1),
  FIELD_REQUESTER_WALLET: z.string().min(1), FIELD_EXECUTOR_WALLET: z.string().min(1), FIELD_REVIEWER_WALLET: z.string().min(1),
  FIELD_PRICE_LAMPORTS: z.string().default('1000000'),
  FIELD_REQUESTER_TOKEN: z.string().regex(/^[0-9a-f]{64}$/), FIELD_CAPABILITY_SECRET: z.string().regex(/^[0-9a-f]{64}$/),
  FIELD_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
}).parse(process.env);
const pool = new Pool({ connectionString: env.FIELD_DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
pool.on('error', () => { console.error('Database connection lost'); });

if (process.argv.includes('--migrate')) {
  try { await migrate(pool); console.log('Database migrated'); }
  finally { await pool.end(); }
} else {
  const store = new Store(pool);
  const chain = new DevnetChainReader();
  const app = buildApp({
    store, chain, logger: true,
    config: { requester: env.FIELD_REQUESTER_WALLET, executor: env.FIELD_EXECUTOR_WALLET, reviewer: env.FIELD_REVIEWER_WALLET,
      priceLamports: env.FIELD_PRICE_LAMPORTS, requesterToken: env.FIELD_REQUESTER_TOKEN, capabilitySecret: env.FIELD_CAPABILITY_SECRET },
  });
  await migrate(pool);
  await app.listen({ host: '127.0.0.1', port: env.FIELD_PORT });
  const stop = startReconciler(store, chain, () => { app.log.error('Reconciliation failed'); });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await stop();
    await pool.end();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
