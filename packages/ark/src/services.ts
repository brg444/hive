import { ensure, fail } from "@hive/kit";

/**
 * The two services the hive talks to over HTTP: arkd, for its keys and its
 * indexer, and the delegatee, which renews, boards and executes the spends
 * handed to it.
 * Both answer grpc-gateway JSON, where 64-bit integers may arrive as strings.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) });

async function call<T>(
  fetchImpl: FetchLike,
  base: string,
  path: string,
  body?: unknown,
  code = "SERVICE",
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const response = await fetchImpl(`${base}${path}`, {
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) fail(code, `${path}: ${json.message ?? `HTTP ${response.status}`}`);
  return json as T;
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  ensure(Number.isSafeInteger(n), "SERVICE", "integer out of range");
  return n;
};

/** A missing expiry stays unknown, including old spent coins retained for history. */
function batchExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === 0 || value === "0") return null;
  ensure(
    typeof value === "number" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value)),
    "INDEXER",
    "invalid batch expiry",
  );
  const expiry = Number(value);
  ensure(Number.isSafeInteger(expiry) && expiry > 0, "INDEXER", "invalid batch expiry");
  return expiry;
}

/** Spending requires affirmative expiry metadata, including observations injected by callers. */
export function requireCoinExpiry(coin: { txid: string; vout: number; expiresAt: number | null }): number {
  const expiry = coin.expiresAt;
  ensure(
    typeof expiry === "number" && Number.isSafeInteger(expiry) && expiry > 0,
    "COIN_EXPIRY_UNKNOWN",
    coin.txid + ":" + coin.vout,
  );
  return expiry;
}

// ---------------------------------------------------------------- arkd

export interface OperatorInfo {
  network: string;
  signerPubkey: string;
  forfeitPubkey: string;
  checkpointTapscript: string;
  unilateralExitDelay: number;
  boardingExitDelay: number;
  dust: number;
}

export interface IndexedCoin {
  txid: string;
  vout: number;
  amount: number;
  script: string;
  createdAt: number;
  /** Null means the indexer has no affirmative batch-expiry data. */
  expiresAt: number | null;
  isSpent: boolean;
  isSwept: boolean;
  isPreconfirmed: boolean;
  spentBy: string;
  settledBy: string;
  arkTxid: string;
  commitmentTxids: string[];
}

export class Arkd {
  constructor(
    readonly url: string,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  async info(): Promise<OperatorInfo> {
    const raw = await call<Record<string, unknown>>(
      this.fetchImpl,
      this.url,
      "/v1/info",
      undefined,
      "OPERATOR",
    );
    return {
      network: String(raw.network),
      signerPubkey: String(raw.signerPubkey),
      forfeitPubkey: String(raw.forfeitPubkey ?? ""),
      checkpointTapscript: String(raw.checkpointTapscript),
      unilateralExitDelay: num(raw.unilateralExitDelay),
      boardingExitDelay: num(raw.boardingExitDelay),
      dust: num(raw.dust),
    };
  }

  /** The base64 PSBTs of offchain transactions, by txid. */
  async virtualTxs(txids: string[], signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < txids.length; i += 50) {
      const raw = await call<{ txs?: string[] }>(
        this.fetchImpl,
        this.url,
        `/v1/indexer/virtualTx/${txids.slice(i, i + 50).join(",")}`,
        undefined,
        "INDEXER",
        signal,
      );
      out.push(...(raw.txs ?? []));
    }
    return out;
  }

  /** Coins at `scripts` or exactly `outpoints`, every page. */
  async coins(
    query: {
      scripts?: string[];
      outpoints?: string[];
      spendableOnly?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<IndexedCoin[]> {
    const out: IndexedCoin[] = [];
    // Pages count from 1; `total` is the number of pages.
    for (let page = 1; ; ) {
      const params = new URLSearchParams();
      for (const s of query.scripts ?? []) params.append("scripts", s);
      for (const o of query.outpoints ?? []) params.append("outpoints", o);
      if (query.spendableOnly) params.set("spendableOnly", "true");
      params.set("page.size", "500");
      params.set("page.index", String(page));
      const raw = await call<{
        vtxos?: Record<string, unknown>[];
        page?: { current?: unknown; total?: unknown };
      }>(this.fetchImpl, this.url, `/v1/indexer/vtxos?${params}`, undefined, "INDEXER", signal);
      for (const v of raw.vtxos ?? []) {
        const outpoint = (v.outpoint ?? {}) as { txid?: string; vout?: unknown };
        out.push({
          txid: String(outpoint.txid),
          vout: num(outpoint.vout),
          amount: num(v.amount),
          script: String(v.script ?? ""),
          createdAt: num(v.createdAt),
          expiresAt: batchExpiry(v.expiresAt),
          isSpent: v.isSpent === true,
          isSwept: v.isSwept === true,
          isPreconfirmed: v.isPreconfirmed === true,
          spentBy: String(v.spentBy ?? ""),
          settledBy: String(v.settledBy ?? ""),
          arkTxid: String(v.arkTxid ?? ""),
          commitmentTxids: ((v.commitmentTxids ?? []) as unknown[]).map(String),
        });
      }
      if (num(raw.page?.current) >= num(raw.page?.total)) return out;
      page = num(raw.page?.current) + 1;
    }
  }
}

// ---------------------------------------------------------------- delegatee

export interface DelegateeInfo {
  network: string;
  delegatePubkey: string;
  serverPubkey: string;
  emulatorPubkey: string;
}

export interface Delegation {
  id: string;
  address: string;
  status: "active" | "cancelled" | "expired" | "done" | string;
  templateId: string;
  expiresAt: number;
  slots: { name: string; tapscripts: string[]; outpoint: string }[];
}

export interface Attempt {
  outpoints: string[];
  /** The batch commitment for intents, the Ark txid for offchain spends. */
  txid: string;
  success: boolean;
  error: string;
  attemptedAt: number;
}

export interface DelegationState {
  delegation: Delegation;
  coins: { outpoint: string; amount: number; expiresAt: number; renewableAt: number }[];
  attempts: Attempt[];
}

export interface SpendRequest {
  templateId: string;
  variables: Record<string, string>;
  outpoints: string[];
  expiresAt: number;
  pubkey: string;
  signature: string;
}

function delegation(raw: Record<string, unknown> | undefined): Delegation {
  ensure(raw, "DELEGATEE_RESPONSE", "no delegation");
  return {
    id: String(raw.id ?? ""),
    address: String(raw.address ?? ""),
    status: String(raw.status ?? "unknown"),
    templateId: String(raw.templateId ?? ""),
    expiresAt: num(raw.expiresAt),
    slots: ((raw.slots ?? []) as Record<string, unknown>[]).map((s) => ({
      name: String(s.name ?? ""),
      tapscripts: ((s.tapscripts ?? []) as unknown[]).map(String),
      outpoint: String(s.outpoint ?? ""),
    })),
  };
}

function state(raw: Record<string, unknown>): DelegationState {
  return {
    delegation: delegation(raw.delegation as Record<string, unknown>),
    coins: ((raw.vtxos ?? []) as Record<string, unknown>[]).map((v) => ({
      outpoint: String(v.outpoint),
      amount: num(v.amount),
      expiresAt: num(v.expiresAt),
      renewableAt: num(v.renewableAt),
    })),
    attempts: ((raw.renewals ?? []) as Record<string, unknown>[]).map((r) => ({
      outpoints: ((r.outpoints ?? []) as unknown[]).map(String),
      txid: String(r.commitmentTxid ?? ""),
      success: r.success === true,
      error: String(r.error ?? ""),
      attemptedAt: num(r.attemptedAt),
    })),
  };
}

export class Delegatee {
  constructor(
    readonly url: string,
    private readonly fetchImpl: FetchLike = defaultFetch,
  ) {}

  private call<T>(path: string, body?: unknown): Promise<T> {
    return call<T>(this.fetchImpl, this.url, path, body, "DELEGATEE");
  }

  async info(): Promise<DelegateeInfo> {
    const raw = await this.call<Record<string, unknown>>("/v1/info");
    return {
      network: String(raw.network),
      delegatePubkey: String(raw.delegatePubkey),
      serverPubkey: String(raw.serverPubkey),
      emulatorPubkey: String(raw.emulatorPubkey),
    };
  }

  async registerArtifact(document: unknown): Promise<string> {
    const raw = await this.call<{ artifact?: { id?: string } }>("/v1/artifact", {
      document: JSON.stringify(document),
    });
    ensure(/^[0-9a-f]{64}$/.test(raw.artifact?.id ?? ""), "DELEGATEE_RESPONSE", "artifact id");
    return raw.artifact!.id!;
  }

  async registerTemplate(document: unknown): Promise<string> {
    const raw = await this.call<{ template?: { id?: string } }>("/v1/template", {
      document: JSON.stringify(document),
    });
    ensure(/^[0-9a-f]{64}$/.test(raw.template?.id ?? ""), "DELEGATEE_RESPONSE", "template id");
    return raw.template!.id!;
  }

  /**
   * `active` while the delegatee acts on the template's watches. It disables a
   * template whose intents are all refused for ten cycles in a row, which stops
   * every watch sharing it until its administrator enables it again.
   */
  async templateStatus(id: string): Promise<string> {
    ensure(/^[0-9a-f]{64}$/.test(id), "INVALID", "template id");
    const raw = await this.call<{ template?: { status?: unknown } }>(`/v1/template/${id}`);
    return String(raw.template?.status ?? "unknown");
  }

  /** A watch: the delegatee acts on every coin at the instance's address. */
  async watch(templateId: string, variables: Record<string, string>, expiresAt = 0): Promise<Delegation> {
    const raw = await this.call<{ delegation?: Record<string, unknown> }>("/v1/delegate", {
      templateId,
      variables,
      expiresAt,
    });
    return delegation(raw.delegation);
  }

  async spend(request: SpendRequest): Promise<{ id: string; delegation: Delegation }> {
    const raw = await this.call<{ id?: string; delegation?: Record<string, unknown> }>("/v1/spend", request);
    ensure(/^[0-9a-f]{64}$/.test(raw.id ?? ""), "DELEGATEE_RESPONSE", "spend id");
    return { id: raw.id!, delegation: delegation(raw.delegation) };
  }

  async address(address: string): Promise<DelegationState> {
    return state(await this.call<Record<string, unknown>>(`/v1/delegate/${encodeURIComponent(address)}`));
  }

  async spendState(id: string): Promise<DelegationState> {
    ensure(/^[0-9a-f]{64}$/.test(id), "INVALID", "spend id");
    return state(await this.call<Record<string, unknown>>(`/v1/spend/${id}`));
  }
}
