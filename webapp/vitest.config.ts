import { defineConfig } from 'vitest/config';

// Unit tests run in plain Node (Node 24 exposes WebCrypto's crypto.subtle and
// atob/btoa as globals — the same primitives the Workers runtime gives us), so
// lib/crypto/blob.ts can be exercised without spinning up workerd. Scope the
// run to test files under src/test/ so the Astro pages and build artifacts are
// never collected. `.mjs` is included so the scripts/*.mjs CLIs (e.g. the
// Phase 3.3 bootstrap importer) can be unit-tested without dragging them into
// the tsc program — keeping `npm run check` clean of JS-import noise.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts', 'src/test/**/*.test.mjs'],
  },
});
