import { defineConfig, devices } from '@playwright/test';

/* The stack (harness.mjs) is started first: CI and local runs both do
   `node harness.mjs &` and wait for it. One API and one database: journeys take turns. */
export default defineConfig({
  testDir: './journeys',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['line'], ['json', { outputFile: 'results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
