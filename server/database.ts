import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(pool: Pool): Promise<void> {
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(1179208780)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, hash text NOT NULL)');
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ hash: string }>('SELECT hash FROM schema_migrations WHERE name = $1', [file]);
      if (previous.rows[0]) {
        if (previous.rows[0].hash !== hash) throw new Error('An applied SQL migration was changed');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, hash) VALUES ($1, $2)', [file, hash]);
    }
  });
}
