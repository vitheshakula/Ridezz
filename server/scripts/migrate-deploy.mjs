import { spawnSync } from 'node:child_process';

const migrationUrl = process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!migrationUrl) {
  console.error('Set MIGRATION_DATABASE_URL (or DATABASE_URL) before running migrations.');
  process.exit(1);
}

const result = spawnSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: migrationUrl },
});
process.exit(result.status ?? 1);
