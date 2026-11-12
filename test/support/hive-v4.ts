import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import {
  type Account,
  type Connection,
  connect,
  type EscrowTerms,
  escrowAccount,
  pairKeys,
  treasuryAccount,
  type TreasuryTerms,
  xOnly,
} from "@hive/ark";
import { closeServer, hex, listenLocal, localPath, secretPath } from "@hive/kit";
import { type QuoteBody, quoteTerms, type SignedQuote, escrowTermsFromQuote } from "@hive/protocol";
import type { Treasury } from "@hive/hive";
import { approveRequest, type SessionRequest, type StewardEndpoint, writeStewardConfig } from "@hive/steward";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { handleStewardRequest } from "../../packages/steward/src/service.js";
import { type FakeNetwork, startFakeNetwork } from "./fake-network.js";
import { makeQuote } from "./quotes.js";

/** A steward run in this process through the same handler as its worker. */
export class LocalSteward implements StewardEndpoint {
  constructor(readonly configPath: string) {}
  describe() {
    return handleStewardRequest(this.configPath, { operation: "describe" }) as never;
  }
  nonce(session: SessionRequest) {
    return handleStewardRequest(this.configPath, { operation: "nonce", session }) as never;
  }
  sign(session: SessionRequest, peerNonces: string[]) {
    return handleStewardRequest(this.configPath, { operation: "sign", session, peerNonces }) as never;
  }
  signLast(session: SessionRequest, peerNonces: string[]) {
    return handleStewardRequest(this.configPath, { operation: "sign-last", session, peerNonces }) as never;
  }
}

export interface HiveFixture {
  fake: FakeNetwork;
  conn: Connection;
  treasury: Treasury;
  account: Account;
  stewardSecrets: Uint8Array[];
  stewardKeys: [string, string, string];
  configPaths: string[];
  /** A quote for this hive, approved by all three stewards' administrators. */
  quote(
    overrides?: Partial<QuoteBody>,
  ): Promise<{ quote: SignedQuote; escrow: EscrowTerms; secrets: ReturnType<typeof makeQuote>["secrets"] }>;
  escrow(terms: EscrowTerms): Promise<Account>;
}

export async function hiveFixture(
  t: TestContext,
  options: { renewalWindowSeconds?: number } = {},
): Promise<HiveFixture> {
  const fake = await startFakeNetwork({ batchLifetimeSeconds: 2 * 86_400 });
  t.after(() => fake.close());
  const conn = await connect(fake.deployment());
  const id = randomUUID();
  const stewardSecrets = [0, 1, 2].map(() => secp256k1.utils.randomSecretKey());
  const stewardKeys = stewardSecrets.map((s) => hex(secp256k1.getPublicKey(s, true))) as [
    string,
    string,
    string,
  ];
  const terms: TreasuryTerms = {
    pairs: pairKeys(stewardKeys),
    exitDelaySeconds: fake.exitDelaySeconds,
    renewalWindowSeconds: options.renewalWindowSeconds ?? 600,
    maxFeeSats: 500,
  };
  const configPaths = stewardSecrets.map((s, i) => {
    const path = secretPath("v4-test", id, `steward-${i}.json`);
    writeStewardConfig(path, {
      schema: "hive-steward/v4",
      secretKey: hex(s),
      statePath: localPath("v4-test", id, `steward-${i}-state.json`),
      deployment: fake.deployment(),
      stewardKeys,
      treasury: {
        exitDelaySeconds: terms.exitDelaySeconds,
        renewalWindowSeconds: terms.renewalWindowSeconds,
        maxFeeSats: terms.maxFeeSats,
      },
      approvedRequests: [],
      approvedWithdrawals: [],
    });
    return path;
  });
  t.after(() => {
    rmSync(secretPath("v4-test", id), { recursive: true, force: true });
    rmSync(localPath("v4-test", id), { recursive: true, force: true });
  });
  const account = await treasuryAccount(conn, terms);
  const stewards = configPaths.map((p) => new LocalSteward(p)) as [LocalSteward, LocalSteward, LocalSteward];
  const treasury: Treasury = { conn, terms, stewardKeys, stewards, artifactId: account.artifactId };
  return {
    fake,
    conn,
    treasury,
    account,
    stewardSecrets,
    stewardKeys,
    configPaths,
    async quote(overrides = {}) {
      const fixture = makeQuote({
        operatorKey: hex(xOnly(conn.keys.server)),
        emulatorKey: hex(xOnly(conn.keys.emulator)),
        treasuryScript: account.pkScript,
        stewardPairKeys: [terms.pairs["01"], terms.pairs["02"], terms.pairs["12"]],
        exitDelaySeconds: String(terms.exitDelaySeconds),
        ...overrides,
      });
      for (const path of configPaths) await approveRequest(path, quoteTerms(fixture.quote.body));
      return {
        quote: fixture.quote,
        escrow: escrowTermsFromQuote(fixture.quote) as EscrowTerms,
        secrets: fixture.secrets,
      };
    },
    escrow: (escrowTerms) => escrowAccount(conn, escrowTerms),
  };
}

/** A sidecar that is already frozen: `/freeze` answers the token totals and the payer's receipt for them. */
export async function frozenSidecar(t: TestContext, totals: Record<string, unknown>): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/freeze") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ frozen: true, sequence: 2, ...totals }));
    } else res.writeHead(404).end();
  });
  const { url } = await listenLocal(server);
  t.after(() => closeServer(server));
  return `${url}/`;
}
