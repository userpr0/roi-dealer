import { defineConfig } from 'vitest/config';

// Workspace packages are resolved to their TypeScript sources through the
// `@roi-dealer/source` export condition, so tests never depend on stale `dist/` builds.
export default defineConfig({
  resolve: { conditions: ['@roi-dealer/source'] },
  ssr: { resolve: { conditions: ['@roi-dealer/source'] } },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
