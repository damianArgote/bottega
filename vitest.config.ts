import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native tsconfig `paths` resolution (no plugin needed).
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    exclude: ['src/generated/**', 'node_modules/**', 'dist/**'],
  },
});
