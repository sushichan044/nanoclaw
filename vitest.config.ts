import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "setup/**/*.test.ts",
      "packages/agent-core/src/**/*.test.ts",
      "container/agent-runner/src/**/*.test.ts",
    ],
  },
});
