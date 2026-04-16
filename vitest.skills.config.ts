import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".agents/skills/**/tests/*.test.ts", ".claude/skills/**/tests/*.test.ts"],
  },
});
