import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentFor, MAINNET_PINS, mainnetDeployment } from "@hive/ark";
import { faultCode } from "@hive/kit";

/**
 * Mainnet runs only with BUZZ_MAINNET=enabled and the delegatee the hive's own server runs, its
 * delegate key named by that server; the Operator's and the Emulator's keys are pinned in the code.
 */
const code = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (error) {
    return faultCode(error);
  }
};

test("mainnet needs BUZZ_MAINNET, then the hive server's delegatee", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  delete process.env.BUZZ_MAINNET;
  delete process.env.BUZZ_DELEGATEE_URL;
  delete process.env.BUZZ_DELEGATE_KEY;
  assert.equal(
    code(() => deploymentFor("bitcoin")),
    "MAINNET_DISABLED",
  );
  process.env.BUZZ_MAINNET = "enabled";
  assert.equal(
    code(() => deploymentFor("bitcoin")),
    "NO_DELEGATEE",
  );
  const delegateKey = `02${"ab".repeat(32)}`;
  assert.equal(
    code(() => mainnetDeployment("https://hive.example.org/delegatee", "02ab")),
    "INVALID",
  );
  assert.equal(
    code(() => mainnetDeployment("http://hive.example.org", delegateKey)),
    "INVALID",
  );
  process.env.BUZZ_DELEGATEE_URL = "https://hive.example.org/delegatee/";
  process.env.BUZZ_DELEGATE_KEY = delegateKey;
  assert.deepEqual(deploymentFor("bitcoin"), {
    network: "bitcoin",
    arkdUrl: "https://arkade.computer",
    delegateeUrl: "https://hive.example.org/delegatee",
    pins: { ...MAINNET_PINS, delegateKey },
  });
});
