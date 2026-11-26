import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// The send flow against the real corridor: the Anchor Platform reference server
// from `scripts/reference-anchor.sh`, the engine served over HTTP by `pnpm serve`,
// and this app pointed at it in proxy mode. It is the browser counterpart to
// `pnpm verify:corridor`, which drives the same lane from Node without a UI, and
// it runs in the `send-flow` job of .github/workflows/reference-corridor.yml.
//
// What the flow can and cannot do against the stack today, asserted rather than
// assumed:
//
//   1. /send stops after its first step. @corridor/service now has POST /routes
//      (#617), but nothing connects the page to it: the web app has no route
//      that proxies it, web/app/send/page.tsx renders <SendApp> without a
//      planner, and `pnpm serve` does not configure routePlanning (the endpoint
//      answers 501 there). So the page says routes can't be listed, and nothing
//      reaches /api/send. When /send is wired to the planner, this test is the
//      one to extend: pick the route, fill the recipient's details, press Send.
//   2. The send app's own server route, /api/send/payments, is what that Send
//      button will call. A payment that names its beneficiary (the anchor's
//      SEP-12 ids and payout fields, registered by
//      scripts/register-reference-customers.ts) goes through it, settles on
//      testnet and is read back through /api/send/payments/:key.
//   3. The /payments runner is the page that can drive a live run today. Its
//      form collects no beneficiary data, so its own run gets a live SEP-38 quote
//      and is then refused for want of a registered receiver. Typing the settled
//      payment's key into it replays the stored run, so what it shows (state,
//      testnet hash, explorer link) is the settlement from (2).
//
// Everything the tests need from the environment is set by that job.

const LIVE = process.env.E2E_REFERENCE_STACK === "1";

const CORRIDOR = process.env.E2E_CORRIDOR_ID ?? "reference-testnet";
// The same amount `pnpm verify:corridor` pays. 10.00 is also the canary cap the
// engine applies to an unproven lane, so a larger figure would be refused for a
// reason that has nothing to do with the anchor.
const AMOUNT = process.env.E2E_AMOUNT ?? "10.00";
const ASSET = "USDC";
// corridors/reference.corridor.yaml: dest.endpoints.home_domain and dest.protocol.
const ROUTE = { receivingDomain: "localhost:8080", protocol: "sep31" };

/** The bearer token /api/payments demands before it proxies to the service. */
const WEB_API_KEY = process.env.E2E_WEB_API_KEY ?? "";
/** Registered against the live anchor by scripts/register-reference-customers.ts. */
const SENDER_SEP12_ID = process.env.E2E_SENDER_SEP12_ID ?? "";
const RECIPIENT_SEP12_ID = process.env.E2E_RECIPIENT_SEP12_ID ?? "";

// The payout instructions the reference server accepts, the same triple
// `examples/verify-corridor.ts` sends.
const DESTINATION_FIELDS = {
  receiver_routing_number: "021000021",
  receiver_account_number: "12345678901234",
  type: "SWIFT",
};

/** The engine's terminal states (web/lib/payment-timeline.ts). */
const TERMINAL = /^(completed|refunded|held|failed)$/;

interface RunStatus {
  state: string;
  stellarTxHash?: string;
  trail?: string[];
  error?: string;
  route?: { receivingDomain: string; protocol: string };
}

const sendPage = {
  amount: (page: Page) => page.getByLabel("Amount", { exact: true }),
  findRoutes: (page: Page) => page.getByRole("button", { name: "Find routes" }),
};

const runner = {
  corridor: (page: Page) => page.getByLabel("Corridor"),
  amount: (page: Page) => page.getByLabel("Source amount"),
  idemKey: (page: Page) => page.getByLabel("Idempotency key"),
  run: (page: Page) => page.getByRole("button", { name: "Run payment" }),
  progress: (page: Page) => page.getByRole("region", { name: "Payment progress" }),
};

/**
 * Wait until React has hydrated a field. A value typed before then is not in
 * the component's state, so the run would go out with the default amount.
 */
async function waitForHydration(field: Locator): Promise<void> {
  await expect
    .poll(() => field.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))))
    .toBe(true);
}

/** Type the intent into the /payments runner and press Run. */
async function runOnPaymentsPage(page: Page, idempotencyKey: string): Promise<void> {
  await page.goto("/payments");
  await waitForHydration(runner.amount(page));
  await runner.corridor(page).selectOption({ value: CORRIDOR });
  await runner.amount(page).fill(AMOUNT);
  await runner.idemKey(page).fill(idempotencyKey);
  await runner.run(page).click();
}

/**
 * POST a payment through the send app's server route and return the run once
 * it is terminal. The route waits on the service for up to five minutes
 * (SERVICE_TIMEOUT_MS in lib/send-proxy.ts) and answers 504 if the run is still
 * going; the service keeps running it, so the run is then read back the way
 * the send app's status view will.
 */
async function sendThroughSendRoute(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ posted?: RunStatus; status: RunStatus }> {
  const key = body.idempotencyKey as string;
  const res = await request.post("/api/send/payments", { data: body, timeout: 6 * 60_000 });
  const answer = (await res.json()) as RunStatus & { error?: string };
  if (res.ok()) return { posted: answer, status: answer };
  expect(res.status(), `POST /api/send/payments: ${JSON.stringify(answer)}`).toBe(504);

  let last: RunStatus | undefined;
  await expect
    .poll(
      async () => {
        const read = await request.get(`/api/send/payments/${key}`);
        if (!read.ok()) return `HTTP ${read.status()}`;
        last = (await read.json()) as RunStatus;
        return last.state;
      },
      { timeout: 15 * 60_000, intervals: [5_000] },
    )
    .toMatch(TERMINAL);
  return { status: last! };
}

test.describe("the send flow against the reference anchor", () => {
  test.skip(
    !LIVE,
    "This spec drives a live corridor. It needs the Anchor Platform reference " +
      "stack, `pnpm serve`, and this app already started in proxy mode " +
      "(CORRIDOR_SERVICE_URL, CORRIDOR_WEB_API_KEY, SEND_APP_SERVICE_URL, " +
      "SEND_APP_CORRIDORS) at E2E_BASE_URL. The send-flow job of " +
      ".github/workflows/reference-corridor.yml does all of it. Set " +
      "E2E_REFERENCE_STACK=1 to run it by hand.",
  );

  test.beforeAll(() => {
    const missing = [
      ["E2E_WEB_API_KEY", WEB_API_KEY],
      ["E2E_SENDER_SEP12_ID", SENDER_SEP12_ID],
      ["E2E_RECIPIENT_SEP12_ID", RECIPIENT_SEP12_ID],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`E2E_REFERENCE_STACK=1 but ${missing.join(", ")} is empty`);
    }
  });

  // Every request carries the bearer token the /api/payments proxy gate asks
  // for, including the runner's own fetches. The shipped page sends none, which
  // is why the gate exists; the test is the operator-authenticated caller.
  // /api/send takes no credential (it is gated by SEND_APP_CORRIDORS instead)
  // and builds its own headers, so the token is not passed on there.
  test.use({ extraHTTPHeaders: { authorization: `Bearer ${WEB_API_KEY}` } });

  test("/send takes the amount and stops before routes, sending nothing", async ({ page }) => {
    const sendCalls: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.startsWith("/api/send")) sendCalls.push(req.url());
    });

    await page.goto("/send");
    await waitForHydration(sendPage.amount(page));
    await sendPage.amount(page).fill(AMOUNT);
    await sendPage.findRoutes(page).click();

    // The gap, stated by the page itself: no route planner is wired, so there
    // are no routes to pick, no recipient fields to load and no Send to press.
    await expect(page.getByRole("heading", { name: "Routes can't be listed here yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
    expect(sendCalls).toEqual([]);
  });

  test("the runner's own run reaches the live lane, and is refused for its missing receiver", async ({
    page,
    request,
  }) => {
    const key = `send-flow-form-${Date.now()}`;
    await runOnPaymentsPage(page, key);

    // The refusal is the engine's compliance step, and it is only reached after
    // the live anchor quoted the payment under SEP-38: a stack that was not up
    // would have produced a connection error instead, and the in-process demo
    // engine has no SEP-12 step at all. The page prints REQUEST_FAILED because
    // the run came back as an error response; the engine's verdict is on the run.
    // Matched on the visible error box: the screen-reader announcement carries
    // the same text as "REQUEST_FAILED: …", without the dash.
    await expect(
      page.getByText(/REQUEST_FAILED — .*recipient has no SEP-12 customer id/),
    ).toBeVisible({ timeout: 90_000 });
    await expect(runner.progress(page).locator("span").first()).toHaveText("failed");

    const res = await request.get(`/api/payments/${key}`);
    expect(res.ok(), `GET /api/payments/${key}: HTTP ${res.status()}`).toBe(true);
    const status = (await res.json()) as RunStatus & { corridorId: string };
    expect(status.state).toBe("failed");
    expect(status.error).toBe("KYC_REQUIRED");
    // `route` is filled by @corridor/service from the run and the corridor's
    // manifest; the demo engine's status payload has no such field, so this is
    // the live lane.
    expect(status.route).toEqual(ROUTE);
  });

  test("a payment through the send app's route settles on testnet, and the runner shows it", async ({
    page,
    request,
  }) => {
    // A corridor run against the reference server waits on the observer's own
    // cadence and on testnet, so this is timed in minutes, not the config default.
    test.setTimeout(25 * 60_000);

    const key = `send-flow-live-${Date.now()}`;
    const { posted, status } = await sendThroughSendRoute(request, {
      idempotencyKey: key,
      corridorId: CORRIDOR,
      sender: { id: "sender-1", jurisdiction: "US", anchorCustomerId: SENDER_SEP12_ID },
      recipient: { id: "recipient-1", jurisdiction: "US", anchorCustomerId: RECIPIENT_SEP12_ID },
      destinationFields: DESTINATION_FIELDS,
      sourceAmount: { asset: ASSET, amount: AMOUNT },
    });

    // Quote, comply, open, the payment on testnet, and the reconciliation that
    // confirms the anchor paid out.
    expect(status.state, `corridor run did not complete: ${JSON.stringify(status)}`).toBe(
      "completed",
    );
    if (posted) {
      expect(posted.trail).toEqual(
        expect.arrayContaining(["quoted", "compliant", "opened", "settled", "completed"]),
      );
    }
    const hash = status.stellarTxHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Read back the way the send app's status view will: through its own route.
    const read = await request.get(`/api/send/payments/${key}`);
    expect(read.ok(), `GET /api/send/payments/${key}: HTTP ${read.status()}`).toBe(true);
    const stored = (await read.json()) as RunStatus;
    expect(stored.state).toBe("completed");
    expect(stored.stellarTxHash).toBe(hash);
    expect(stored.route).toEqual(ROUTE);

    // Now a page, on the same key: the service replays the stored run, so the
    // state and the explorer link it shows come from the settlement above.
    await runOnPaymentsPage(page, key);
    await expect(runner.progress(page).locator("span").first()).toHaveText("completed", {
      timeout: 60_000,
    });
    const link = runner
      .progress(page)
      .getByRole("link", { name: /opens stellar\.expert in a new tab/i });
    await expect(link).toHaveAttribute("href", `https://stellar.expert/explorer/testnet/tx/${hash}`);
    await expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
