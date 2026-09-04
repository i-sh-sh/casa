#!/usr/bin/env node
// db/schema.sql is the file a person reads and edits. db/schema.ts is the file
// the migration endpoint imports, because a Vercel function only ships what its
// code statically references and a runtime `readFileSync` of a .sql file is not
// something the bundler can see through — the deploy would succeed and the
// migration would fail with ENOENT, on the one request meant to fix things.
//
// So: edit the .sql, run `npm run schema:build`, commit both. A test fails if
// they drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_PATH = join(root, 'db', 'schema.sql');
const TS_PATH = join(root, 'db', 'schema.ts');

const HEADER = `// GENERATED FROM db/schema.sql — do not edit by hand.
// Run \`npm run schema:build\` after changing the .sql file.
//
// It exists because a Vercel function only bundles what it statically
// references: reading the .sql at runtime deploys fine and then fails with
// ENOENT on the one request that is supposed to repair the database.

export const SCHEMA_SQL = \``;

export function toModule(sql: string): string {
  const escaped = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `${HEADER}${escaped}\`;\n`;
}

// Only when run directly — importing this from a test must not rewrite files.
if (process.argv[1]?.endsWith('build-schema.ts')) {
  const sql = readFileSync(SQL_PATH, 'utf8');
  const next = toModule(sql);
  const current = (() => {
    try { return readFileSync(TS_PATH, 'utf8'); } catch { return null; }
  })();
  if (current === next) {
    console.log('db/schema.ts is up to date');
  } else {
    writeFileSync(TS_PATH, next);
    console.log(`wrote db/schema.ts (${next.length} bytes)`);
  }
}
