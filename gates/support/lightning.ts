import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensure, Fault, repositoryRoot } from "@hive/kit";

/**
 * Pay a BOLT11 invoice from the regtest stack's peer Lightning node, through the
 * stack's own CLI (`regtest.mjs pay-invoice`). The stack defaults to the Colima
 * checkout under `regtest/` with `.env.regtest`; `BUZZ_REGTEST_DIR`,
 * `BUZZ_REGTEST_ENV` and `BUZZ_DOCKER_CONTEXT` point it at another stack.
 */
export function payRegtestInvoice(invoice: string): Promise<void> {
  ensure(/^lnbcrt[0-9]+[munp]?1[02-9ac-hj-np-z]+$/.test(invoice), "INVALID", "regtest BOLT11 invoice");
  const directory = process.env.BUZZ_REGTEST_DIR ?? resolve(repositoryRoot, "regtest");
  const envFile = process.env.BUZZ_REGTEST_ENV ?? resolve(repositoryRoot, ".env.regtest");
  // The default names the local Docker setup this project grew up on; set the variable for another.
  const context = process.env.BUZZ_DOCKER_CONTEXT ?? "colima-buzz-pool";
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["regtest.mjs", "pay-invoice", invoice, "--env", envFile], {
      cwd: directory,
      env: { ...process.env, CI: "1", ...(context ? { DOCKER_CONTEXT: context } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Fault("LIGHTNING_PAYMENT", `pay-invoice exited ${code}: ${output.slice(-300)}`));
    });
  });
}
