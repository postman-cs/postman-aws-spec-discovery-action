import { defineConfig } from 'vitest/config';

// Emulator lane: LocalStack-backed transport proofs for the shipped CLI bundle.
// Runs only via `npm run test:emulator:aws` inside the budgeted CI lane (or a
// local operator shell with LocalStack up); never part of default `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    include: ['tests/emulator/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
