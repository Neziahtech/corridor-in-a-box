import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import generatedStates from "../lib/generated/states.json" with { type: "json" };

// Every step of the send flow on /payments, stopped long enough for axe to
// judge it: the form, the submission, the run walking the state machine, and
// each way a run can end. Keyboard order and focus are checked alongside,
// because "navigable" is not something axe can infer from markup alone.
//
// The steps the flow does not have yet — ranked route options, the recipient
// fields from the anchor's required list — are their own open issues; when they
// land, they get a step here.

/** axe's WCAG A, AA and 2.2 checks, plus its own best-practice rules. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

// The engine caps a payment on a lane nobody has proven at 10 units (`run.ts`'s
// canary gate), and every corridor the demo serves is unproven. The form's own
// default of 100.00 is therefore refused before anything happens, so these
// checks send an amount that reaches the rest of the flow.
const AMOUNT = "5.00";

async function expectAccessible(page: Page, step: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations,
    `axe found issues at the "${step}" step:\n` +
      violations
        .map(
          (v) =>
            `  ${v.id} (${v.impact}, ${v.nodes.length} node(s)) — ${v.help}\n` +
            v.nodes
              .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary}`)
              .join("\n"),
        )
        .join("\n"),
  ).toEqual([]);
}

/**
 * The accessible name of whatever holds focus: the text of the label that points
 * at it, else its own text. A tab order is only worth asserting if it is
 * described the way a screen reader would describe it.
 */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "";
    const id = el.getAttribute("id");
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return (label?.textContent ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
  });
}

const controls = {
  corridor: (page: Page) => page.getByLabel("Corridor"),
  amount: (page: Page) => page.getByLabel("Source amount"),
  scenario: (page: Page) => page.getByLabel("Scenario"),
  idemKey: (page: Page) => page.getByLabel("Idempotency key"),
  run: (page: Page) => page.getByRole("button", { name: "Run payment" }),
  running: (page: Page) => page.getByRole("button", { name: "Running…" }),
  reset: (page: Page) => page.getByRole("button", { name: "Reset" }),
  progress: (page: Page) => page.getByRole("region", { name: "Payment progress" }),
};

/** The state in the progress timeline's own badge — "waiting" until it can see the run. */
function timelineState(page: Page) {
  return controls.progress(page).locator("span").first();
}

// Read from the engine's generated state list rather than copied here, so a new
// terminal state cannot leave these checks waiting for something that never ends.
const TERMINAL = generatedStates.terminal;

/** Wait until the timeline has stopped polling because the run reached an end state. */
async function waitForTerminalState(page: Page) {
  await expect
    .poll(
      async () => TERMINAL.includes((await timelineState(page).textContent())?.trim() ?? ""),
      { timeout: 40_000 },
    )
    .toBe(true);
}

/**
 * Hold the POST so the submitting step stays on screen: against a mock engine
 * that answers at once, the spinner would be gone before axe finished. Calling
 * the returned function lets the run go on.
 */
async function holdSubmission(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/payments", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    return route.continue();
  });
  return () => release();
}

/** Start a run with the given scenario and wait for the timeline to catch it. */
async function send(page: Page, scenario?: string) {
  await controls.amount(page).fill(AMOUNT);
  if (scenario) await controls.scenario(page).selectOption({ label: scenario });
  await controls.run(page).click();
  await expect(controls.progress(page)).toBeVisible();
}

test.describe("the send flow", () => {
  // The demo store lives as long as the server does, so a repeated key replays
  // an earlier check's run instead of walking the flow. Each test gets its own.
  const run = Math.random().toString(36).slice(2, 8);

  test.beforeEach(async ({ page }, testInfo) => {
    await page.goto("/payments");
    await expect(page.getByRole("heading", { level: 1, name: "Run a payment" })).toBeVisible();
    await controls.idemKey(page).fill(`a11y-${testInfo.testId}-${run}`);
  });

  test("the form is labelled, and its controls follow in reading order", async ({ page }) => {
    await expectAccessible(page, "form");

    // Every control reachable by Tab alone, in the order it is announced: no
    // focus trap, and nothing only a mouse can reach.
    await controls.corridor(page).focus();
    const order = [await focusedName(page)];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      order.push(await focusedName(page));
    }
    expect(order).toEqual([
      "Corridor",
      "Source amount",
      "Scenario",
      "Idempotency key",
      "Run payment",
      "Reset",
    ]);
  });

  test("submitting, then following the payment to completed", async ({ page }) => {
    const release = await holdSubmission(page);
    await controls.amount(page).fill(AMOUNT);
    await controls.run(page).click();

    // While the request is in flight the run is not stored yet, so the timeline
    // says "waiting" and the controls are disabled — a keyboard user must still
    // be told what the page is doing.
    await expect(controls.running(page)).toBeVisible();
    await expect(controls.running(page)).toBeDisabled();
    await expect(timelineState(page)).toHaveText("waiting");
    await expectAccessible(page, "submitting");

    release();
    await expect(controls.running(page)).toBeVisible();
    await expectAccessible(page, "in progress");

    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("completed");
    await expectAccessible(page, "completed");

    // The same key again: the run is replayed instead of repeated, and the page
    // says which of the two it is showing.
    await controls.run(page).click();
    await waitForTerminalState(page);
    await expectAccessible(page, "idempotent replay");
  });

  test("a quote that expired before it was used", async ({ page }) => {
    await send(page, "Quote expired");
    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("failed");
    await expectAccessible(page, "quote refused");
  });

  test("a settlement that fails and comes back refunded", async ({ page }) => {
    await send(page, "Settlement retries then fails");
    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("refunded");
    await expectAccessible(page, "refunded");
  });

  test("a reconciliation that stalls into a hold", async ({ page }) => {
    await send(page, "Reconciliation stalls and holds");
    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("held");
    await expectAccessible(page, "held");
  });

  test("an amount the engine refuses is tied to the field, and focused", async ({ page }) => {
    await controls.amount(page).fill("abc");
    await controls.run(page).click();

    await expect(controls.amount(page)).toHaveAttribute("aria-invalid", "true");
    // Focus moves to the field that has to be fixed rather than staying on the
    // button just pressed, and the refusal is read out as the field's own error.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      await controls.amount(page).getAttribute("id"),
    );
    expect(await focusedName(page)).toBe("Source amount");
    await expectAccessible(page, "amount refused");
  });

  test("a settled payment links its transaction without losing the thread", async ({ page }) => {
    // The mock submitter answers with a placeholder hash, so no real run here can
    // produce the explorer link. The response shape is the engine's own; only the
    // hash is the 64-hex form a settlement actually has.
    const hash = "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889";
    await page.route("**/api/payments", (route) =>
      route.fulfill({
        json: {
          ok: true,
          state: "completed",
          trail: ["created", "quoted", "compliant", "opened", "settled", "completed"],
          transactionId: "tx_1",
          stellarTxHash: hash,
        },
      }),
    );
    await page.route("**/api/payments/*", (route) =>
      route.fulfill({ json: { idempotencyKey: "demo-0001", state: "completed", stellarTxHash: hash } }),
    );

    await controls.amount(page).fill(AMOUNT);
    await controls.run(page).click();
    await waitForTerminalState(page);

    const link = controls.progress(page).getByRole("link", { name: /stellar\.expert/i });
    await expect(link).toHaveAttribute("rel", "noreferrer");
    await expect(link).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${hash}`);
    await expectAccessible(page, "settled with explorer link");
  });

  test("a status endpoint that is not answering", async ({ page }) => {
    await page.route("**/api/payments/*", (route) =>
      route.fulfill({ status: 500, json: { error: "anchor status unavailable" } }),
    );
    await controls.amount(page).fill(AMOUNT);
    await controls.run(page).click();

    // The run itself still completes, so the page has to say that the progress
    // reading failed rather than let the timeline go quiet.
    await expect(controls.progress(page).getByText(/status unavailable/i)).toBeVisible();
    await expectAccessible(page, "status unavailable");
  });

  test("the checks above are not vacuous", async ({ page }) => {
    // A green run means axe judged this page with the real stylesheet applied,
    // not that it had nothing to say. So break the page on purpose and require
    // the checks to notice each break.
    await page.goto("/payments");

    // 1. an input whose label is gone, 2. grey text that misses the AA ratio.
    await page.evaluate(() => {
      for (const label of document.querySelectorAll('label[for$="-amount"]')) {
        label.remove();
      }
      const faint = document.createElement("p");
      faint.textContent = "grey text on a white page";
      faint.style.color = "#808080";
      document.querySelector("main")?.append(faint);
    });

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const ids = violations.map((v) => v.id);
    expect(ids.includes("label"), `unlabelled input not caught: ${ids}`).toBe(true);
    expect(ids.includes("color-contrast"), `low contrast not caught: ${ids}`).toBe(true);

    // 3. the amount field stops being reachable by keyboard — precisely what the
    // tab-order check above exists to catch.
    await page.reload();
    await page.locator("input[inputmode='decimal']").evaluate((el) =>
      el.setAttribute("tabindex", "-1"),
    );
    await controls.corridor(page).focus();
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      order.push(await focusedName(page));
    }
    expect(order.includes("Source amount"), `tab order was: ${order.join(", ")}`).toBe(false);
  });
});
