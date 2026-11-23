import { defineConfig, devices } from "@playwright/test";

// The checks in e2e/ run against `next start`, i.e. the production build. axe
// decides colour contrast and focus visibility from the styles the browser
// actually applied, and those come from the compiled Tailwind stylesheet — a dev
// server would leave the contrast half of WCAG unmeasured.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// E2E_BASE_URL means the app is already running and configured by whoever set
// it — the live reference-stack job starts it with CORRIDOR_SERVICE_URL, which
// this config could not supply. Without it, the run below builds and serves its
// own production app.
const externalApp = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".playwright-output",
  // One browser at a time. /api/payments keeps runs in a process-local store, so
  // two specs polling their own idempotency keys against one server share it;
  // serial runs keep each spec's view of the flow its own.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["line"]] : [["list"]],
  use: {
    baseURL,
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: externalApp
    ? undefined
    : {
        command: `pnpm build && pnpm start --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}`,
        // Reuse a server already on the port: iterating on one spec locally
        // should not pay for a Next build every time. CI always starts its own.
        reuseExistingServer: !process.env.CI,
        // A cold `next build` on a slow laptop is minutes; CI is warm and much faster.
        timeout: process.env.CI ? 300_000 : 900_000,
      },
});
