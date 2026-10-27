import { defineConfig } from 'vitest/config';

// Integration tests exercise real external programs (mpv, ffmpeg) and, for the
// rendering checks, an X display (use Xvfb in CI). They are skipped with a
// clear message when a dependency is missing instead of silently passing.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
