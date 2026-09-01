import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    // Mirror the "@/*" alias from tsconfig.json so tests import the same way app code does.
    alias: { "@": resolve(import.meta.dirname, ".") },
  },
});
