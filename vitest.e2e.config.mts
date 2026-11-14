import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Browser tests against a production build and the Auth and Firestore
// emulators. Run through `npm run test:e2e` after `npm run build`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
