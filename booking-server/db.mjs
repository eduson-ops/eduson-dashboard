import { readFile, mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const schemas = ['schema.sql','compensation-schema.sql','operational-schema.sql','slack-schema.sql'].map(name=>new URL(name,import.meta.url));
const result = value => ({ ...value, rows: value.rows || [], rowCount: value.rowCount ?? value.affectedRows ?? value.rows?.length ?? 0 });

/** PostgreSQL owns the data in both modes. Embedded mode uses a single queued connection. */
export async function openDatabase({ databaseUrl, dataDir, memory = false } = {}) {
  const sql = (await Promise.all(schemas.map(schema=>readFile(schema,'utf8')))).join('\n');
  if (databaseUrl) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      // DATE is a business date, not a UTC instant. Preserve it on hosts in any timezone.
      types: { getTypeParser: (oid, format) => oid === 1082 ? value => value : pg.types.getTypeParser(oid, format) }
    });
    try { await pool.query(sql); } catch (error) { await pool.end(); throw error; }
    return {
      kind: 'postgres',
      query: async (text, values = []) => result(await pool.query(text, values)),
      transaction: async fn => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn({ query: async (text, values = []) => result(await client.query(text, values)) });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
      close: () => pool.end()
    };
  }
  if (!memory && !dataDir) throw new Error('Для PostgreSQL укажите databaseUrl либо каталог dataDir; для тестов memory:true.');
  if (!memory) await mkdir(dataDir, { recursive: true });
  const embedded = new PGlite(memory ? undefined : dataDir);
  await embedded.waitReady;
  await embedded.exec(sql);
  let tail = Promise.resolve();
  let closed = false;
  const enqueue = fn => {
    if (closed) return Promise.reject(new Error('База данных закрыта.'));
    const pending = tail.then(fn);
    tail = pending.catch(() => {});
    return pending;
  };
  return {
    kind: 'pglite',
    query: (text, values = []) => enqueue(async () => result(await embedded.query(text, values))),
    transaction: fn => enqueue(() => embedded.transaction(tx => fn({ query: async (text, values = []) => result(await tx.query(text, values)) }))),
    close: async () => {
      if (closed) return;
      closed = true;
      await tail;
      await embedded.close();
    }
  };
}
