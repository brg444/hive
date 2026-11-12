import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { ensure, fail, LOCAL_ROOT, repositoryRoot, sha256Hex } from "@hive/kit";

/**
 * One gate run's public evidence: docs/evidence/v4/<suite>/<run>/.
 * Files are created once and never replaced, and every write is scanned for
 * the run's registered secrets before it lands.
 */
export class GateRun {
  readonly directory: string;
  readonly startedAt = new Date().toISOString();
  readonly #secrets = new Set<string>();
  readonly #sources: (() => Iterable<string>)[] = [];
  #interrupted = false;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static create(suite: string): GateRun {
    ensure(/^[a-z0-9][a-z0-9-]*$/.test(suite), "INVALID", "suite name");
    const parent = resolve(evidenceRoot(), suite);
    for (
      let path = parent;
      path.startsWith(repositoryRoot) && path !== repositoryRoot;
      path = resolve(path, "..")
    ) {
      ensure(!existsSync(path) || !lstatSync(path).isSymbolicLink(), "EVIDENCE_REDIRECTED");
    }
    mkdirSync(parent, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const directory = resolve(parent, `${stamp}-${randomUUID()}`);
    mkdirSync(directory); // Exclusive: never adopt another run's directory.
    return new GateRun(directory);
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  /** Record a signal synchronously before closing resources or terminating the process. */
  handleInterrupts(
    context: { schema: string; schemaVersion: number; runId: string },
    close: () => Promise<void>,
  ): () => void {
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      if (this.#interrupted) return;
      this.#interrupted = true;
      const code = signal === "SIGINT" ? 130 : 143;
      process.exitCode = code;
      try {
        this.write("failure.json", {
          ...context,
          status: "stopped",
          code: "INTERRUPTED",
          signal,
          at: new Date().toISOString(),
        });
      } catch {
        // Do not print arbitrary error data from a partially initialized gate.
        process.stderr.write("Could not write the gate interruption record.\n");
      }
      const deadline = setTimeout(() => process.exit(code), 2_000);
      deadline.unref();
      void Promise.resolve()
        .then(close)
        .then(
          () => process.exit(code),
          () => process.exit(code),
        );
    };
    const sigint = () => stop("SIGINT");
    const sigterm = () => stop("SIGTERM");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    return () => {
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
    };
  }

  /** Strings that must never appear in public evidence, such as private keys and bearer tokens. */
  forbid(...secrets: string[]): void {
    for (const secret of secrets) if (secret.length >= 16) this.#secrets.add(secret.toLowerCase());
  }

  /** Secrets created during the run, such as per-request transport keys, read again before each write. */
  forbidFrom(source: () => Iterable<string>): void {
    this.#sources.push(source);
  }

  path(name: string): string {
    ensure(/^[a-z0-9][a-z0-9.-]*$/.test(name), "INVALID", "evidence file name");
    return resolve(this.directory, name);
  }

  write(name: string, value: unknown): string {
    const text = `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;
    this.#scan(text);
    const path = this.path(name);
    const descriptor = openSync(path, "wx", 0o644);
    try {
      writeSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return relative(repositoryRoot, path);
  }

  /** An append-only log; each line is scanned like any other evidence. */
  log(name: string): { append(line: string): void; close(): void } {
    const descriptor = openSync(this.path(name), "wx", 0o644);
    return {
      append: (line) => {
        this.#scan(line);
        writeSync(descriptor, line.endsWith("\n") ? line : `${line}\n`);
      },
      close: () => {
        fsyncSync(descriptor);
        closeSync(descriptor);
      },
    };
  }

  #scan(text: string): void {
    const lower = text.toLowerCase();
    for (const secret of this.#secrets) if (lower.includes(secret)) fail("SECRET_IN_EVIDENCE");
    for (const source of this.#sources)
      for (const secret of source())
        if (secret.length >= 16 && lower.includes(secret.toLowerCase())) fail("SECRET_IN_EVIDENCE");
  }
}

export function evidenceRoot(fallback = resolve(repositoryRoot, "docs/evidence/v4")): string {
  const override = process.env.BUZZ_EVIDENCE_ROOT;
  if (!override) return fallback;
  const path = resolve(override);
  ensure(path.startsWith(`${LOCAL_ROOT}/`), "INVALID", "BUZZ_EVIDENCE_ROOT must be under .local/");
  return path;
}

/** SHA-256 of every tracked source the gate depends on, keyed by repository path. */
export function sourceHashes(): Record<string, string> {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|json|py|go|mod|sum|ark)$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of ["packages", "gates", "contracts", "tools"]) walk(directory);
  files.push("package.json", "pnpm-lock.yaml", "tsconfig.json");
  return Object.fromEntries(
    files
      .filter((path) => !path.includes("node_modules/"))
      .sort()
      .map((path) => [path, sha256Hex(readFileSync(resolve(repositoryRoot, path)))]),
  );
}
