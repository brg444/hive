import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * What a host runs straight from the checkout must be runnable: a unit whose script lost its
 * executable bit fails every time it starts, and for the backup that means no backups.
 */
const root = new URL("..", import.meta.url).pathname;
const units = join(root, "deploy/systemd");

test("every script a systemd unit starts, and the setup itself, is executable", () => {
  const scripts = new Set(["deploy/setup.sh"]);
  for (const unit of readdirSync(units).filter((f) => f.endsWith(".service"))) {
    for (const line of readFileSync(join(units, unit), "utf8").split("\n")) {
      const started = /^ExecStart(?:Pre|Post)?=-?\/opt\/hive\/(\S+)/.exec(line);
      if (started) scripts.add(started[1]!);
    }
  }
  assert.ok(scripts.has("tools/backup.sh") && scripts.has("tools/check.sh"), "the units' scripts were found");
  for (const script of scripts)
    assert.ok(
      statSync(join(root, script)).mode & 0o111,
      `${script} is not executable: its unit cannot start it`,
    );
});

test("the backup takes every key the host keeps, the issuer's among them", () => {
  const backup = readFileSync(join(root, "tools/backup.sh"), "utf8");
  for (const kept of [".secrets/bitcoin", ".secrets/ops", ".secrets/issuer", ".local/service", ".local/ops"])
    assert.ok(backup.includes(kept), `${kept} is not in the backup`);
});
