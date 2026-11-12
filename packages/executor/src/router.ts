import { ensure, faultCode } from "@hive/kit";
import type { Observation } from "./observe.js";
import {
  requireRejection,
  type Action,
  type Route,
  type RouteAnswer,
  type RouteContext,
  type RouteName,
  routeFailure,
} from "./routes.js";

export interface Attempt {
  route: RouteName;
  at: number;
  result: RouteAnswer["result"];
  detail?: string;
  reference?: string;
}

export interface PreparedAttempt {
  sequence: number;
  route: RouteName;
  preparedAt: number;
  answeredAt?: number;
  response?: RouteAnswer;
  /** Old journals recorded only responses; preserve their conservative retry state. */
  legacy?: true;
}

export interface ExecutionState {
  schema: "hive-execution/v1";
  action: Action;
  routes: RouteName[];
  attempts: PreparedAttempt[];
  /** Pre-v1 journals could lose a response before recording any attempt. */
  legacyUnknown?: true;
}

export type Outcome =
  | { status: "done"; txid: string; route?: RouteName; attempts: Attempt[]; execution: ExecutionState }
  | {
      status: "pending" | "expired" | "elsewhere" | "invalid";
      attempts: Attempt[];
      execution: ExecutionState;
      observation?: Observation;
    };

export interface RouterOptions {
  routes: Route[];
  observe: (action: Action, signal?: AbortSignal) => Promise<Observation>;
  graceSeconds?: number;
  patienceMs?: number;
  retryMs?: number;
  pollMs?: number;
  now?: () => number;
}

const ordered = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(ordered)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, value]) => [k, ordered(value)]),
        )
      : v;
const sameAction = (a: Action, b: Action) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

export function executionState(
  action: Action,
  routes: RouteName[],
  legacy: Attempt[] = [],
  legacyUnknown = false,
): ExecutionState {
  return {
    schema: "hive-execution/v1",
    action: structuredClone(action),
    routes: [...new Set([...legacy.map((attempt) => attempt.route), ...routes])],
    ...(legacyUnknown ? { legacyUnknown: true } : {}),
    attempts: legacy.map((a, i) => ({
      sequence: i + 1,
      route: a.route,
      preparedAt: a.at,
      answeredAt: a.at,
      legacy: true,
      response: {
        result: a.result,
        ...("detail" in a
          ? {
              detail:
                typeof a.detail === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(a.detail)
                  ? a.detail
                  : "LEGACY_RECORDED_ERROR",
            }
          : {}),
        ...(a.reference && /^[0-9a-f]{64}$/.test(a.reference) ? { reference: a.reference } : {}),
      } as RouteAnswer,
    })),
  };
}

export function executionAttempts(state: ExecutionState): Attempt[] {
  return state.attempts.flatMap((a) =>
    a.response
      ? [
          {
            route: a.route,
            at: a.answeredAt ?? a.preparedAt,
            result: a.response.result,
            ...("detail" in a.response ? { detail: a.response.detail } : {}),
            ...("reference" in a.response && a.response.reference ? { reference: a.response.reference } : {}),
          },
        ]
      : [],
  );
}

export function executionRefused(state: ExecutionState | undefined): boolean {
  return Boolean(state?.attempts.some((a) => a.response?.result === "refused"));
}

/** The fixed action and each prepared attempt are durably acknowledged before any route posts. */
export class Router {
  private readonly graceSeconds: number;
  private readonly patienceMs: number;
  private readonly retryMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  constructor(private readonly options: RouterOptions) {
    this.graceSeconds = options.graceSeconds ?? 600;
    this.patienceMs = options.patienceMs ?? 30_000;
    this.retryMs = options.retryMs ?? 15_000;
    this.pollMs = options.pollMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }
  get routes(): RouteName[] {
    return this.options.routes.map((r) => r.name);
  }
  withRoutes(routes: Route[], timing: Pick<RouterOptions, "patienceMs" | "retryMs" | "pollMs"> = {}): Router {
    return new Router({ ...this.options, ...timing, routes });
  }
  route(name: RouteName): Route | undefined {
    return this.options.routes.find((r) => r.name === name);
  }

  async execute(
    action: Action,
    options: {
      timeoutMs?: number;
      routes?: RouteName[];
      observe?: (action: Action, signal?: AbortSignal) => Promise<Observation>;
      beforeSubmit?: (context?: RouteContext) => void | Promise<void>;
      execution?: ExecutionState;
      legacyAttempts?: Attempt[];
      legacyUnknown?: boolean;
      onState?: (state: ExecutionState) => void | Promise<void>;
      onAttempt?: (attempt: Attempt) => void | Promise<void>;
      /** Registration APIs return after one route response; this never means the spend finalized. */
      returnAfterPost?: boolean;
      observeOnly?: boolean;
      /** Bounds a route phase from its first prepared attempt, including acceptance patience. */
      routeBudgetMs?: Partial<Record<RouteName, number>>;
      /** Additional transport authorization expiry; never extends Action.validUntil. */
      postUntil?: number;
    } = {},
  ): Promise<Outcome> {
    const state = options.execution
      ? structuredClone(options.execution)
      : executionState(action, options.routes ?? this.routes, options.legacyAttempts, options.legacyUnknown);
    ensure(/^[0-9a-f]{64}$/.test(action.txid) && Number.isFinite(action.validUntil), "ACTION_MISMATCH");
    ensure(state.schema === "hive-execution/v1" && sameAction(state.action, action), "EXECUTION_MISMATCH");
    ensure(
      state.routes.length === new Set(state.routes).size &&
        state.attempts.every(
          (a, i) =>
            a.sequence === i + 1 &&
            state.routes.includes(a.route) &&
            Number.isFinite(a.preparedAt) &&
            (a.answeredAt === undefined || Number.isFinite(a.answeredAt)) &&
            (!a.response || ["accepted", "unavailable", "refused", "invalid"].includes(a.response.result)),
        ),
      "EXECUTION_STATE",
    );
    const observe = options.observe ?? this.options.observe;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const started = performance.now();
    const deadline = this.now() + timeoutMs;
    const remainingBudget = () =>
      Math.max(0, Math.min(deadline - this.now(), timeoutMs - (performance.now() - started)));
    const boundedObservation = async (): Promise<Observation> => {
      if (remainingBudget() <= 0) return "pending";
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          observe(state.action, controller.signal).catch((error) => {
            if (["ACTION_MISMATCH", "EXECUTION_MISMATCH"].includes(faultCode(error))) throw error;
            return "pending" as const;
          }),
          new Promise<Observation>((resolve) => {
            timer = setTimeout(
              () => {
                controller.abort();
                resolve("pending");
              },
              Math.max(1, remainingBudget()),
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    };
    const validUntilMs =
      Math.min(
        action.validUntil,
        action.request?.expiresAt ?? action.validUntil,
        options.postUntil ?? Infinity,
      ) * 1000;
    const postDeadline = Math.min(deadline, validUntilMs);
    const routeDeadline = (name: RouteName) => {
      const first = state.attempts.find((attempt) => attempt.route === name)?.preparedAt;
      const budget = options.routeBudgetMs?.[name];
      return first !== undefined && budget !== undefined
        ? Math.min(postDeadline, first + budget)
        : postDeadline;
    };
    const enabled = options.routes ?? this.routes;
    const answers = () => executionAttempts(state);
    const result = (
      status: "pending" | "expired" | "elsewhere" | "invalid",
    ): Exclude<Outcome, { status: "done" }> => ({
      status,
      attempts: answers(),
      execution: structuredClone(state),
    });
    // A durability writer is fully awaited while the caller retains its lock.
    // Racing an arbitrary writer could let it overwrite newer state after a resume.
    const save = async () => {
      ensure(options.onState, "EXECUTION_JOURNAL_REQUIRED");
      await options.onState(structuredClone(state));
    };
    const refusal = () => state.attempts.find((a) => a.response?.result === "refused")?.route;
    const postable = () => remainingBudget() > 0 && this.now() < postDeadline && enabled.length > 0;
    let next = state.routes[0];
    let waitUntil = 0;
    const last = state.attempts.at(-1);
    if (last) {
      next = last.route;
      const answered = last.answeredAt ?? last.preparedAt;
      if (last.response && refusal()) {
        next = refusal();
        waitUntil = answered + this.retryMs;
      } else if (!last.response || last.response.result === "accepted") {
        waitUntil = Math.min(answered + this.patienceMs, routeDeadline(last.route));
        next = state.routes[(state.routes.indexOf(last.route) + 1) % state.routes.length];
      } else if (last.response.result === "unavailable") {
        next = state.routes[(state.routes.indexOf(last.route) + 1) % state.routes.length];
        if (next === state.routes[0]) waitUntil = answered + this.retryMs;
      } else waitUntil = answered + this.retryMs;
    }
    for (;;) {
      const seen = await boundedObservation();
      if (seen === "spent") {
        const accepted = [...state.attempts].reverse().find((a) => a.response?.result === "accepted");
        return {
          status: "done",
          txid: action.txid,
          ...(accepted ? { route: accepted.route } : {}),
          attempts: answers(),
          execution: structuredClone(state),
        };
      }
      if (seen === "elsewhere") return result("elsewhere");
      if (state.attempts.some((a) => a.response?.result === "invalid")) return result("invalid");
      if (
        seen === "unspent" &&
        !state.legacyUnknown &&
        state.attempts.length === 0 &&
        this.now() > action.validUntil * 1000 + this.graceSeconds * 1000
      )
        return result("expired");
      if (remainingBudget() <= 0) return result("pending");
      if (
        options.returnAfterPost &&
        state.attempts.at(-1)?.response?.result === "accepted" &&
        enabled.includes(state.attempts.at(-1)!.route)
      )
        return result("pending");
      if (options.observeOnly) return { ...result("pending"), observation: seen };
      const pinned = refusal();
      if (pinned) next = pinned;
      if (seen === "unspent" && postable() && this.now() >= waitUntil && next) {
        const route = enabled.includes(next) ? this.route(next) : undefined;
        if (!route) {
          if (pinned) return result("pending");
          const index = state.routes.indexOf(next);
          const candidates = state.routes.slice(index + 1).concat(state.routes.slice(0, index));
          const available = candidates.find((name) => enabled.includes(name) && this.route(name));
          if (!available) return result("pending");
          const prior = state.attempts.at(-1);
          if (
            prior?.response?.result === "unavailable" &&
            state.routes.indexOf(available) <= state.routes.indexOf(prior.route)
          )
            waitUntil = Math.max(waitUntil, (prior.answeredAt ?? prior.preparedAt) + this.retryMs);
          next = available;
          continue;
        }
        const prepared: PreparedAttempt = {
          sequence: state.attempts.length + 1,
          route: route.name,
          preparedAt: this.now(),
        };
        state.attempts.push(prepared);
        await save();
        if (!postable()) {
          // This call knows no transport began; do not make a resume wait for a lost response.
          prepared.response = { result: "unavailable", detail: "EXECUTION_DEADLINE" };
          prepared.answeredAt = this.now();
          await save();
          await options.onAttempt?.(answers().at(-1)!);
          return result("pending");
        }
        const attemptDeadline = pinned ? postDeadline : routeDeadline(route.name);
        const controller = new AbortController();
        const context: RouteContext = {
          signal: controller.signal,
          deadline: attemptDeadline,
          remainingMs: () => Math.max(0, Math.min(attemptDeadline - this.now(), remainingBudget())),
          recheckPostable: () => {
            ensure(
              !controller.signal.aborted && remainingBudget() > 0 && this.now() < attemptDeadline,
              "EXECUTION_DEADLINE",
            );
          },
          beforePost: async () => {
            context.recheckPostable();
            await options.beforeSubmit?.(context);
            context.recheckPostable();
          },
        };
        let answer: RouteAnswer;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new Error("execution deadline"));
            }, context.remainingMs());
          });
          answer = await Promise.race([route.submit(structuredClone(state.action), context), aborted]);
          if (answer.result === "refused") requireRejection(answer.proof, state.action, route.name);
        } catch (error) {
          answer =
            controller.signal.aborted || faultCode(error) === "EXECUTION_DEADLINE"
              ? { result: "unavailable", detail: "EXECUTION_DEADLINE" }
              : routeFailure(error);
        } finally {
          if (timeout) clearTimeout(timeout);
          controller.abort();
        }
        prepared.response = answer;
        prepared.answeredAt = this.now();
        await save();
        await options.onAttempt?.(answers().at(-1)!);
        if (options.returnAfterPost) {
          const observed = await boundedObservation();
          if (observed === "spent")
            return {
              status: "done",
              txid: action.txid,
              ...(answer.result === "accepted" ? { route: route.name } : {}),
              attempts: answers(),
              execution: structuredClone(state),
            };
          return result(
            answer.result === "invalid" ? "invalid" : observed === "elsewhere" ? "elsewhere" : "pending",
          );
        }
        if (answer.result === "invalid") return result("invalid");
        if (refusal()) {
          next = refusal();
          waitUntil = prepared.answeredAt + this.retryMs;
        } else if (answer.result === "accepted") {
          next = state.routes[(state.routes.indexOf(route.name) + 1) % state.routes.length];
          waitUntil = Math.min(prepared.answeredAt + this.patienceMs, routeDeadline(route.name));
        } else {
          next = state.routes[(state.routes.indexOf(route.name) + 1) % state.routes.length];
          if (next === state.routes[0]) waitUntil = prepared.answeredAt + this.retryMs;
        }
        continue;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(this.pollMs, Math.max(1, remainingBudget()))),
      );
    }
  }
}
