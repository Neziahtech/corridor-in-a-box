// Registers the SEP-12 customers a corridor run needs against the reference
// anchor, and prints their ids as shell assignments.
//
//   scripts/reference-anchor.sh up
//   CORRIDOR_SIGNER_SECRET=S... pnpm exec tsx scripts/register-reference-customers.ts
//
// A conformant SEP-31 anchor will not open a transaction that names no
// registered receiver. In the web app, /send cannot reach its recipient details
// form yet (there is no route planner to pick a route from) and the /payments
// runner has no beneficiary fields, so the browser test of #693 cannot produce
// the ids itself. The workflow registers them once, up front, and pipes this
// output into $GITHUB_ENV:
//
//   SENDER_SEP12_ID=<id>
//   RECIPIENT_SEP12_ID=<id>
//
// Same manifest, same wiring and the same sample PII as `pnpm verify:corridor`
// (examples/verify-corridor.ts), which registers exactly these two on every run.
// Progress, and the preflight doctor's own output, go to stderr so stdout holds
// only the two assignments.
//
//   CORRIDOR_SIGNER_SECRET=S...   required
//   MANIFEST=...                  default corridors/reference.corridor.yaml
//   REFERENCE_ANCHOR_URL=...      default http://localhost:8080
//   HORIZON_URL=...               default https://horizon-testnet.stellar.org
//   SKIP_DOCTOR=1                 skip the preflight (stack managed elsewhere)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCorridor } from "@corridor/manifest";
import {
  pinToReferenceAnchor,
  registerSep12Customer,
  wireCorridorDeps,
  EXIT_MANIFEST,
  EXIT_MISSING_ENV,
  EXIT_NOT_COMPLETED,
  EXIT_REFUSED,
  EXIT_STACK_UNFIT,
} from "../packages/cli/src/wire.js";

const ANCHOR = (process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";

function resolveManifestPath(): string {
  const p = process.env.MANIFEST ?? "corridors/reference.corridor.yaml";
  return p.startsWith("/") ? p : fileURLToPath(new URL(`../${p}`, import.meta.url));
}

async function main(): Promise<void> {
  const secret = process.env.CORRIDOR_SIGNER_SECRET;
  if (!secret) {
    console.error(`✗ missing required env var CORRIDOR_SIGNER_SECRET`);
    process.exit(EXIT_MISSING_ENV);
  }

  const loaded = loadCorridor(resolveManifestPath());
  if (!loaded.ok) {
    console.error(`✗ manifest error: ${loaded.error.message}`);
    process.exit(EXIT_MANIFEST);
  }
  // Testnet only, same guard and same reasoning as `pnpm verify:corridor`: this
  // registers customers at a LOCAL reference anchor.
  if (loaded.value.settlement.network === "public") {
    console.error(
      `✗ corridor "${loaded.value.id}" settles on MAINNET (network=public). This script ` +
        `registers customers with a local reference anchor and will not touch real money.`,
    );
    process.exit(EXIT_REFUSED);
  }

  const corridor = pinToReferenceAnchor(loaded.value, ANCHOR);

  if (!process.env.SKIP_DOCTOR) {
    // Not preflightDoctor() from wire.ts: that inherits stdout, and the doctor's
    // report would land in $GITHUB_ENV beside the ids. Its stdout goes to our
    // stderr instead (fd 2).
    const doctor = fileURLToPath(new URL("./reference-anchor.sh", import.meta.url));
    const doc = spawnSync(doctor, ["doctor"], { stdio: ["ignore", 2, 2] });
    if (doc.error || doc.status !== 0) {
      console.error(
        `✗ the reference anchor is not fit to run a corridor ` +
          `(doctor ${doc.error ? doc.error.message : `exit ${doc.status}`}).`,
      );
      process.exit(EXIT_STACK_UNFIT);
    }
  }

  const { adapter } = wireCorridorDeps(corridor, {
    signerSecret: secret,
    horizonUrl: HORIZON,
  });

  const ids: Record<string, string> = {};
  for (const [envName, role, type] of [
    ["SENDER_SEP12_ID", "sender", corridor.compliance.sep12_sender_type],
    ["RECIPIENT_SEP12_ID", "receiver", corridor.compliance.sep12_receiver_type],
  ] as const) {
    console.error(`registering ${role} (SEP-12) at ${ANCHOR}…`);
    const reg = await registerSep12Customer(adapter, role, type);
    if (!reg.ok) {
      console.error(
        `✗ SEP-12 ${role} registration failed: ${reg.error.code} — ${reg.error.message}`,
      );
      process.exit(EXIT_NOT_COMPLETED);
    }
    ids[envName] = reg.value;
    console.error(`  ${role}: ${reg.value}`);
  }

  for (const [name, value] of Object.entries(ids)) console.log(`${name}=${value}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
