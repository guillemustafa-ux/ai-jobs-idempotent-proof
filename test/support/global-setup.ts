import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const SCHEMA_FILES = ['supabase/migrations/0001_ai_jobs.sql'];

/**
 * One real Postgres for the whole run.
 *  - DATABASE_URL set: use that server (CI uses a postgres:16 service container).
 *  - otherwise: start Postgres 16 with `embedded-postgres` in a fresh directory under the OS
 *    temp dir (never inside the repo) and remove it afterwards.
 * Either way the tests get a brand-new database that is dropped at the end, so an existing
 * DATABASE_URL is never written to outside that throwaway database.
 */
export default async function setup(project: TestProject) {
  const external = (process.env.DATABASE_URL || '').replace(/"/g, '');
  let baseUrl = external;
  let stopEmbedded: (() => Promise<void>) | undefined;

  if (!external) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'ai-jobs-pg-'));
    const port = await freePort();
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const server = new EmbeddedPostgres({
      databaseDir: join(dataRoot, 'data'),
      port,
      user: 'postgres',
      password: 'postgres',
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
    baseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    stopEmbedded = async () => {
      await server.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    };
  }

  const dbName = `ai_jobs_test_${process.pid}_${Date.now()}`;
  await runSql(baseUrl, `create database ${dbName}`);
  const databaseUrl = withDatabase(baseUrl, dbName);
  for (const file of SCHEMA_FILES) await runSql(databaseUrl, readFileSync(file, 'utf8'));

  project.provide('databaseUrl', databaseUrl);

  return async () => {
    await runSql(baseUrl, `drop database if exists ${dbName} with (force)`);
    await stopEmbedded?.();
  };
}

async function runSql(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
