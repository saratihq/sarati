import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // jsdom everywhere: cookies, localStorage and `fetch` are load-bearing in the units under test.
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    // The suite owns its environment. `TZ` because date formatting is under test and a machine's
    // own zone must not decide the expected output; the API URLs because they are inlined at build
    // time — inheriting them let a developer's `.env.local` pass what CI's `same-origin` failed.
    env: {
      TZ: "UTC",
      NEXT_PUBLIC_API_URL: "http://localhost:8001",
      NEXT_PUBLIC_AGENT_URL: "http://localhost:8010",
    },
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
