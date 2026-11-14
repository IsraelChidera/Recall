import { defineConfig } from "vitest/config";

// Firestore rules tests. Run through `npm run test:rules`, which starts the
// Firestore emulator first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rules/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
