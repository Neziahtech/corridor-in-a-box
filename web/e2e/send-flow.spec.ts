import { expect, test, type Page } from "@playwright/test";

// The send flow against the real corridor: the Anchor Platform reference server
// from `scripts/reference-anchor.sh`, the engine served over HTTP by `pnpm serve`,
// and this app pointed at it in proxy mode (`CORRIDOR_SERVICE_URL`). It is the
// browser counterpart to `pnpm verify:corridor`, which drives the same lane from
// Node without a UI, and it runs in the `send-flow` job of
// .github/workflows/reference-corridor.yml.
//
// What the flow can and cannot do at the stack today, asserted rather than
// assumed:
//
//   1. The form collects no beneficiary data, so what it submits names no
//      receiver. The engine gets a live quote for it and then refuses to settle
//      on an unverified recipient. That refusal is the expected outcome here —
//      it is the point the recipient-fields screen (#688) will move past.
//   2. An intent that does carry the anchor's SEP-12 receiver id and payout
//      fields settles on testnet. The second test submits one through this app's
//      own API route — the same server-side proxy the form's request travels —
//      and then types that run's idempotency key into the page, which replays
//      the stored run: what ends up on screen is the settlement the anchor and
//      testnet actually performed, hash included.
//
// Everything the test needs from the environment is set by that job.

const LIVE = process.env.E2E_REFERENCE_STACK === "1";

const CORRIDOR = process.env.E2E_CORRIDOR_ID ?? "reference-testnet";
// The same amount `pnpm verify:corridor` pays, and the same asset the form's
// amount field is labelled with. 10.00 is also the canary cap the gate applies
// to a lane this attested, so a larger figure would be refused for a reason that
// has nothing to do with the anchor.
const AMOUNT = process.env.E2E_AMOUNT ?? "10.00";
const ASSET = "USDC";

/** The bearer token the app's gated proxy demands from a caller that proxies. */
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

const controls = {
  corridor: (page: Page) => page.getByLabel("Corridor"),
  amount: (page: Page) => page.getByLabel("Source amount"),
  idemKey: (page: Page) => page.getByLabel("Idempotency key"),
  run: (page: Page) => page.getByRole("button", { name: "Run payment" }),
  progress: (page: Page) => page.getByRole("region", { name: "Payment progress" }),
};

/** Type the intent into the form and press Run. */
async function submitForm(page: Page, idempotencyKey: string): Promise<void> {
  await page.goto("/payments");
  await controls.corridor(page).selectOption({ value: CORRIDOR });
  await controls.amount(page).fill(AMOUNT);
  await controls.idemKey(page).fill(idempotencyKey);
  await controls.run(page).click();
}

test.describe("the send flow against the reference anchor", () => {
  test.skip(
    !LIVE,
    "This spec drives a live corridor. It needs the Anchor Platform reference " +
      "stack, `pnpm serve`, and this app started with CORRIDOR_SERVICE_URL and " +
      "CORRIDOR_WEB_API_KEY — the send-flow job of " +
      ".github/workflows/reference-corridor.yml does all three. Set " +
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

  // Every request the browser makes carries the bearer token the proxy gate
  // asks for, including the form's own fetch. The shipped app sends none, which
  // is why the gate exists; the test is the operator-authenticated caller.
  test.use({ extraHTTPHeaders: { authorization: `Bearer ${WEB_API_KEY}` } });

  test("what the form sends reaches the live lane, and is refused for its missing receiver", async ({
    page,
    request,
  }) => {
    const key = `send-flow-form-${Date.now()}`;
    await submitForm(page, key);

    // The refusal is the engine's compliance policy, and it is only reachable
    // after the live anchor quoted the payment under SEP-38 — a stack that was
    // not up would have produced a connection error instead, and the in-process
    // demo engine produces its canary gate. The code the page prints is
    // REQUEST_FAILED because the run came back as an error response; the engine's
    // own verdict is on the run.
    await expect(page.getByText(/recipient has no SEP-12 customer id/)).toBeVisible();
    await expect(controls.progress(page).locator("span").first()).toHaveText("failed");

    const res = await request.get(`/api/payments/${key}`);
    const status = (await res.json()) as {
      state: string;
      corridorId: string;
      error?: string;
      route?: { receivingDomain: string; protocol: string };
    };
    expect(status.state).toBe("failed");
    expect(status.error).toBe("KYC_REQUIRED");
    // `route` is served from the corridor's own manifest by @corridor/service;
    // the demo status payload has no such field, so this is the real lane.
    expect(status.route).toEqual({ receivingDomain: "localhost:8080", protocol: "sep31" });
  });

  test("a run that names its beneficiary settles on testnet, and the page follows it", async ({
    page,
    request,
  }) => {
    // A corridor run against the reference server waits on the observer's own
    // cadence and on testnet, so this is timed in minutes, not the config default.
    test.setTimeout(25 * 60_000);

    const key = `send-flow-live-${Date.now()}`;
    const res = await request.post(
      "/api/payments",
      {
        data: {
          idempotencyKey: key,
          corridorId: CORRIDOR,
          sender: { id: "sender-1", jurisdiction: "US", sep12Id: SENDER_SEP12_ID },
          recipient: { id: "recipient-1", jurisdiction: "US", sep12Id: RECIPIENT_SEP12_ID },
          destinationFields: DESTINATION_FIELDS,
          sourceAmount: { asset: ASSET, amount: AMOUNT },
        },
        timeout: 20 * 60_000,
      },
    );
    const run = (await res.json()) as {
      state: string;
      trail?: string[];
      stellarTxHash?: string;
      error?: string;
      message?: string;
    };
    // The route handler answers when the run reaches a terminal state, so this
    // POST is the settlement — quote, comply, open, the payment on testnet, and
    // the reconciliation that confirms the anchor paid out.
    expect(run.state, `corridor run failed: ${JSON.stringify(run)}`).toBe("completed");
    expect(run.trail).toEqual(
      expect.arrayContaining(["quoted", "compliant", "opened", "settled", "completed"]),
    );
    const hash = run.stellarTxHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Now the page, on the same key: the service replays the stored run, so the
    // state and the explorer link it shows come from the settlement above.
    await submitForm(page, key);
    await expect(controls.progress(page).locator("span").first()).toHaveText("completed");

    const link = controls
      .progress(page)
      .getByRole("link", { name: /opens stellar\.expert in a new tab/i });
    await expect(link).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
    await expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
