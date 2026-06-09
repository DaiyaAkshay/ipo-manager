import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 30s — Argon2 with 256 MB memoryCost is slow per call (~500 ms × multiple)
    testTimeout: 30_000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      // Tests use a stub keytar — Windows credential manager isn't available
      // in CI / from outside the Electron runtime.
      'keytar': resolve(__dirname, 'tests/_stubs/keytar.ts'),
    },
  },
});
