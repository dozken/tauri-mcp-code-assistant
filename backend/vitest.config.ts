import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Vitest transforms with esbuild, which does not emit `design:paramtypes`.
    // Without SWC here, any test that boots the Nest container fails to resolve
    // constructor dependencies — the same reason `nest start` uses the SWC builder.
    swc.vite({
      // `.swcrc` excludes spec files (it configures the dev *build*); these inline
      // options are authoritative for tests.
      swcrc: false,
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          useDefineForClassFields: false,
        },
        keepClassNames: true,
      },
      module: { type: 'es6' },
      sourceMaps: true,
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Indexing and container tests touch the filesystem; a generous ceiling keeps
    // CI honest without hiding a hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.module.ts',
        'src/**/*.types.ts',
        'src/**/*.tokens.ts',
        'src/main.ts',
        'src/mcp-server.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 82, statements: 90 },
    },
  },
});
