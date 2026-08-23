import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'sfud-e2e-'));

try {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SFUD_E2E_DATA_DIRECTORY: dataDirectory,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`Playwright가 ${signal} 신호로 종료되었습니다.`));
      else resolve(code ?? 1);
    });
  });
  process.exitCode = exitCode;
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
