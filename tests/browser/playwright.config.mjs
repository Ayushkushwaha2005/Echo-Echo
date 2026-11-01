import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './journeys',
  /* One API and one database: journeys take turns. */
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node harness.mjs',
    url: 'http://127.0.0.1:4173/admin/',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
