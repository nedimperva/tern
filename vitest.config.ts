import { defineConfig } from "vitest/config";

// Unit tests for the UI's pure modules (src/test). No Solid plugin: they are plain TypeScript, and the plugin would
// ask for jsdom. A test that needs a DOM says `// @vitest-environment jsdom` at its top.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
