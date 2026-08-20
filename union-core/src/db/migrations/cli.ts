import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './runner.js';

function loadEnvIfPresent() {
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../.env')
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const val = trimmed.substring(eqIdx + 1).trim();
          if (!process.env[key] && val !== '') {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

async function main() {
  loadEnvIfPresent();
  console.log('[MIGRATION] Starting UNIÓN migration runner...');
  const rootMigrationsDir = path.resolve(process.cwd(), 'union-core/migrations');
  const localMigrationsDir = path.resolve(process.cwd(), 'migrations');

  const migrationsDir = fs.existsSync(rootMigrationsDir)
    ? rootMigrationsDir
    : fs.existsSync(localMigrationsDir)
      ? localMigrationsDir
      : path.resolve(process.cwd(), '../union-core/migrations');

  const result = await runMigrations({ migrationsDir });
  console.log(
    `[MIGRATION] Migration run complete. Applied: ${result.appliedCount}, Already Applied: ${result.alreadyAppliedCount}`
  );
}

main().catch((err: unknown) => {
  console.error('[MIGRATION_ERROR]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
