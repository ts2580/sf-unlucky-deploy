import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const e2eDataDirectory = process.env.SFUD_E2E_DATA_DIRECTORY;
if (e2eDataDirectory === undefined) {
  throw new Error('Playwright는 npm run test:e2e로 실행해 주세요.');
}
const webServerCommand = process.env.SFUD_E2E_SKIP_BUILD === '1'
  ? 'node dist/cli.js ui --no-open'
  : 'npm run build && node dist/cli.js ui --no-open';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  webServer: {
    command: webServerCommand,
    url: 'http://127.0.0.1:27546/api/v1/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      LOCAL: 'false',
      SFUD_CONFIG_DIR: path.join(e2eDataDirectory, 'home-config'),
      SFUD_UI_HOST: '127.0.0.1',
      SFUD_UI_PORT: '27546',
      SFUD_BOOTSTRAP_TOKEN: 'sfud-e2e-bootstrap-token',
      SFUD_DATA_DIR: e2eDataDirectory,
    },
  },
  use: {
    ...devices['Desktop Chrome'],
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
