import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Stryker re-runs the suite once per mutant, so the container tests — which boot a
 * full Nest app and, in one case, a real HTTP server — dominate the wall clock and
 * exhaust memory at any useful concurrency. They verify wiring, not the branch
 * logic mutation testing grades, so the mutation run uses the unit suite only.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['src/**/*.spec.ts', 'test/mcp-server.spec.ts'],
      coverage: { enabled: false },
    },
  }),
);
