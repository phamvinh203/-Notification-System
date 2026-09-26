import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // các file test dùng chung 1 file SQLite + 1 Redis DB → chạy tuần tự tránh đè nhau
    fileParallelism: false,
  },
});
