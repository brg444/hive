"""Phase 2 gate: two MeshLLM 0.79 nodes paying each other on a local Arkade stack.

The provider's node runs pay-arkade as seller and serves a small model; the hive agent's node runs
it as buyer and joins the provider's mesh. This script stands in for the keepers, funding each job
it finds in the buyer's funding queue from the regtest faucet, and checks where every sat lands:

  1. The gated model is visible to the paying buyer, and its first request opens a job.
  2. Once the escrow holds the cap, requests are served and each answer is receipted.
  3. Before the deadline the provider claims the latest receipt; the rest returns to the treasury.
  4. A second job is funded and never used; after its deadline the buyer returns it whole.

Run it with the regtest stack up and intent fees cleared (see the README).
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL_SHA = "5a1395716f7913741cc51d98581b9b1228d80987a9f7d3664106742eb06bba83"
MODEL_ID = "local-gguf/sha256-" + MODEL_SHA
CAP = 20_000
PRICE = 10_000_000_000  # 10 sats a token, so a few short answers cross the 330-sat floor
PERIOD = 100            # each job's life, in seconds
MARGIN = 40             # the seller stops admitting and claims this long before the deadline
GRACE = 10              # the buyer returns an unclaimed escrow this long after the deadline
INDEXER = "http://localhost:7070/v1/indexer/vtxos"


def free_ports(n):
    socks = [socket.socket() for _ in range(n)]
    for s in socks:
        s.bind(("127.0.0.1", 0))
    ports = [s.getsockname()[1] for s in socks]
    for s in socks:
        s.close()
    return ports


def http(url, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    # Mainnet's indexer sits behind Cloudflare, which refuses Python's default user agent.
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json", "user-agent": "pay-arkade-gate/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


def until(what, check, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            value = check()
        except Exception:
            value = None
        if value:
            return value
        time.sleep(1)
    raise TimeoutError(f"timed out waiting for: {what}")


def events(path):
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def first(path, name, after=0, **match):
    return next((e for e in events(path)[after:] if e["event"] == name and all(e.get(k) == v for k, v in match.items())), None)


def plugin_block(binary, args):
    quoted = ", ".join(json.dumps(a) for a in args)
    return f"""[[plugin]]
name = "pay-arkade"
command = {json.dumps(str(binary))}
args = [{quoted}]

[plugin.openai_exchange_grant]
endpoints = ["chat_completions", "completions", "responses"]
phases = ["request_received", "backend_selected", "exchange_finished"]
metadata = true
request_body = true
admission = true
failure_policy = "required"
deadline_ms = 30000
max_body_bytes = 1048576
max_queue_bytes = 4194304
max_in_flight = 32
"""


def mesh_default():
    """The MeshLLM binary the gates run: $PAY_ARKADE_MESH, else mesh-llm on PATH."""
    return Path(os.environ.get("PAY_ARKADE_MESH") or shutil.which("mesh-llm") or "mesh-llm")


def model_default():
    """A small GGUF model for the gates: $PAY_ARKADE_MODEL."""
    path = os.environ.get("PAY_ARKADE_MODEL")
    if not path:
        sys.exit("set PAY_ARKADE_MODEL to a small GGUF model, or pass --model")
    return Path(path)


class Node:
    def __init__(self, mesh, home, log, args):
        self.log = log
        env = dict(os.environ, HOME=str(home))
        self.proc = subprocess.Popen([str(mesh), "serve", "--log-format", "json", *args], env=env,
                                     stdout=open(log, "w"), stderr=subprocess.STDOUT)

    def invite(self):
        def token():
            for line in self.log.read_text().splitlines():
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("event") == "invite_token":
                    return e["token"]
        return until("invite token", token, 120)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def worker_call(worker, key_file, net, op, **body):
    line = json.dumps({"id": 1, "op": op, **body}) + "\n"
    out = subprocess.run([str(worker), "--key-file", str(key_file), *net], input=line,
                         capture_output=True, text=True, timeout=60).stdout
    reply = json.loads(out.splitlines()[0])
    if "ok" not in reply:
        raise RuntimeError(f"worker {op}: {reply.get('error')}")
    return reply["ok"]


def faucet(address, amount):
    note = subprocess.check_output(["docker", "exec", "arkd", "arkd", "note", "--amount", "100000"], text=True).strip()
    subprocess.run(["docker", "exec", "arkd", "ark", "redeem-notes", "-n", note, "--password", "secret"], check=True, capture_output=True)
    subprocess.run(["docker", "exec", "arkd", "ark", "send", "--to", address, "--amount", str(amount), "--password", "secret"],
                   check=True, capture_output=True)


def live_coins(pk_script):
    status, body = http(f"{INDEXER}?scripts={pk_script}&spendableOnly=true", timeout=30)
    return [(v["outpoint"]["txid"], int(v["amount"]), v.get("expiresAt")) for v in body.get("vtxos", [])] if status == 200 else []


def balances(pk_script):
    status, body = http(f"{INDEXER}?scripts={pk_script}&spendableOnly=true", timeout=30)
    return sorted(int(v["amount"]) for v in body.get("vtxos", [])) if status == 200 else []


def contains(values, wanted):
    """Every wanted value is among values, counting repeats; a real wallet holds other coins too."""
    pool = list(values)
    for w in wanted:
        if w not in pool:
            return False
        pool.remove(w)
    return True


def chat(api, max_tokens=12):
    return http(api + "/chat/completions", {"model": MODEL_ID, "messages": [{"role": "user", "content": "Name a color."}],
                                            "temperature": 0, "max_tokens": max_tokens, "stream": False}, timeout=120)


def main():
    global CAP, PERIOD, MARGIN, GRACE, INDEXER
    p = argparse.ArgumentParser()
    p.add_argument("--mesh", type=Path, default=mesh_default())
    p.add_argument("--model", type=Path, default=None, help="small GGUF model (default: $PAY_ARKADE_MODEL)")
    p.add_argument("--plugin", type=Path, default=ROOT / "plugin/target/debug/pay-arkade")
    p.add_argument("--worker", type=Path, default=ROOT / "worker/dist/pay-arkade-worker")
    p.add_argument("--out", type=Path, default=ROOT / "gate/out")
    p.add_argument("--provider-archive", type=Path,
                   help="set the provider up only with packaging/install-provider.sh and this plugin archive")
    # Off regtest: real operator and emulator, funding by hand, returns and earnings to a real address.
    p.add_argument("--network", default="regtest")
    p.add_argument("--executor", default=None, help="executord URL: escrows are renewed instead of needing long-lived coins")
    p.add_argument("--renew-after-secs", type=int, default=None,
                   help="with --delegate: renew job 1's escrow this long after funding, and wait to see it renewed")
    p.add_argument("--delegate", default=None, help="delegate service URL (the Arkade wallet's): escrows are renewed from a renewal both sides presign")
    p.add_argument("--operator")
    p.add_argument("--emulator")
    p.add_argument("--treasury-address", help="returns go here (default: a throwaway regtest key)")
    p.add_argument("--payout-address", help="the provider's earnings go here (default: its claim key's address)")
    p.add_argument("--cap", type=int, default=CAP)
    p.add_argument("--period", type=int, default=PERIOD)
    p.add_argument("--margin", type=int, default=MARGIN)
    p.add_argument("--grace", type=int, default=GRACE)
    p.add_argument("--funding-wait", type=int, default=900, help="seconds to wait for a hand-funded escrow")
    p.add_argument("--expiry-only", action="store_true",
                   help="run only the unused job: funded, never served, returned whole after its deadline")
    a = p.parse_args()
    a.model = a.model or model_default()
    CAP, PERIOD, MARGIN, GRACE = a.cap, a.period, a.margin, a.grace
    regtest = a.network == "regtest"
    net = ["--network", a.network] + (["--operator", a.operator] if a.operator else []) + (["--emulator", a.emulator] if a.emulator else [])
    INDEXER = f"{a.operator or 'http://localhost:7070'}/v1/indexer/vtxos"
    a.out.mkdir(parents=True, exist_ok=True)
    for f in a.out.glob("*"):
        f.unlink()
    result = {"steps": []}

    def step(name, **detail):
        result["steps"].append({"step": name, **detail})
        print(f"- {name}: {json.dumps(detail)}", flush=True)

    with tempfile.TemporaryDirectory(prefix="pay-arkade-gate-") as tmp:
        tmp = Path(tmp)
        key = tmp / "probe.key"
        if not regtest:
            pre = worker_call(a.worker, key, net, "preflight")
            step("preflight", **pre)
            assert pre["ok"], pre
        if a.treasury_address:
            treasury = {"address": a.treasury_address, **worker_call(a.worker, key, net, "address_info", address=a.treasury_address)}
        else:
            treasury = worker_call(a.worker, tmp / "treasury.key", net, "info")
        step("treasury", address=treasury["address"])
        payout = worker_call(a.worker, key, net, "address_info", address=a.payout_address) if a.payout_address else None
        seller_log, buyer_log, queue = a.out / "seller.jsonl", a.out / "buyer.jsonl", a.out / "funding-queue.jsonl"
        common = ["--worker", str(a.worker), "--model", MODEL_ID, "--close-margin-secs", str(MARGIN), *net]
        # Regtest coins live minutes; elsewhere keep the plugin's one-day default.
        common += ["--min-coin-life-secs", "30"] if regtest else []
        common += ["--executor", a.executor] if a.executor else []
        common += ["--delegate", a.delegate] if a.delegate else []
        common += ["--renew-after-secs", str(a.renew_after_secs)] if a.renew_after_secs else []
        # Two private nodes on one machine: gating is waived explicitly, never by default.
        common += [] if regtest else ["--allow-any-peer"]
        homes = {"provider": tmp / "provider", "buyer": tmp / "buyer"}
        for role, home in homes.items():
            (home / ".mesh-llm").mkdir(parents=True)
        if a.provider_archive:
            # The provider gets exactly what a real one would: the archive and the install script.
            install = subprocess.run([str(ROOT / "packaging/install-provider.sh"), "--archive", str(a.provider_archive),
                                      "--gguf", str(a.model), "--mesh-llm", str(a.mesh), "--network", "regtest",
                                      "--price-msat-per-mtok", str(PRICE), "--",
                                      "--close-margin-secs", str(MARGIN), "--max-unreceipted-sats", "2000", "--min-coin-life-secs", "30"],
                                     env=dict(os.environ, HOME=str(homes["provider"])), capture_output=True, text=True)
            assert install.returncode == 0, install.stdout + install.stderr
            seller_log = homes["provider"] / ".mesh-llm/pay-arkade/events.jsonl"
            step("provider installed", output=[l for l in install.stdout.splitlines() if l.startswith(("Plugin", "Config", "Claim"))])
        else:
            (homes["provider"] / ".mesh-llm/config.toml").write_text(plugin_block(a.plugin, [
                "--role", "seller", *common, "--state-dir", str(tmp / "seller-state"), "--log", str(seller_log),
                "--price-msat-per-mtok", str(PRICE), "--max-unreceipted-sats", "2000",
                *(["--payout-pk-script", payout["pkScript"]] if payout else [])]))
        (homes["buyer"] / ".mesh-llm/config.toml").write_text(plugin_block(a.plugin, [
            "--role", "buyer", *common, "--state-dir", str(tmp / "buyer-state"), "--log", str(buyer_log),
            "--treasury-program", treasury["program"], "--funding-queue", str(queue), "--cap-sats", str(CAP),
            "--period-secs", str(PERIOD), "--max-price-msat-per-mtok", str(PRICE), "--expire-grace-secs", str(GRACE)]))

        ports = free_ports(4)
        nodes = []
        try:
            provider = Node(a.mesh, homes["provider"], a.out / "provider-node.log",
                            ["--gguf", str(a.model), "--port", str(ports[0]), "--console", str(ports[1])])
            nodes.append(provider)
            until("seller terms published", lambda: first(seller_log, "terms_published"), 180)
            buyer = Node(a.mesh, homes["buyer"], a.out / "buyer-node.log",
                         ["--join", provider.invite(), "--port", str(ports[2]), "--console", str(ports[3])])
            nodes.append(buyer)
            api = f"http://127.0.0.1:{ports[2]}/v1"

            # 1. The paying buyer sees the gated model; its first request opens a job.
            def visible():
                status, body = http(api + "/models", timeout=5)
                return status == 200 and any(m["id"] == MODEL_ID for m in body.get("data", []))
            until("gated model visible to the buyer", visible, 300)
            status, body = chat(api)
            step("first request, no job yet", status=status, body=body)
            assert status != 200, body

            def fund(n):
                lines = until(f"funding request {n}", lambda: (events(queue) if len(events(queue)) >= n else None), 60)
                request = lines[n - 1]
                wait = 60
                if regtest:
                    faucet(request["address"], request["cap_sats"])
                    step(f"keepers funded job {n}", job_id=request["job_id"], address=request["address"], cap_sats=request["cap_sats"],
                         deadline_in=request["deadline"] - int(time.time()))
                else:
                    # A person plays the keepers: send exactly the cap, in one payment, to this address.
                    (a.out / "FUND.txt").write_text(f"{request['address']} {request['cap_sats']}\n")
                    step(f"waiting for funding of job {n}", address=request["address"], cap_sats=request["cap_sats"],
                         deadline_in=request["deadline"] - int(time.time()))
                    wait = a.funding_wait
                until(f"job {n} open on the buyer", lambda: first(buyer_log, "job_open", job_id=request["job_id"]), wait)
                until(f"job {n} open on the seller", lambda: first(seller_log, "job_open", job_id=request["job_id"]), 60)
                return request

            if a.expiry_only:
                job = fund(1)
                expired = until("buyer returns the unused job", lambda: first(buyer_log, "expired", job_id=job["job_id"]),
                                job["deadline"] - time.time() + GRACE + 120)
                step("expired", txid=expired["txid"], returned_sats=expired["returned_sats"])
                assert expired["returned_sats"] == CAP, expired
                final = until("treasury holds the return", lambda: (b if CAP in (b := balances(treasury["pkScript"])) else None), 60)
                step("treasury", balances=final)
            else:
                job1 = fund(1)
                locked = CAP
                if a.renew_after_secs:
                    # The delegate service renews the escrow into itself; serving and the claim go on from the new coin.
                    escrow_script = worker_call(a.worker, tmp / "probe.key", net, "address_info", address=job1["address"])["pkScript"]
                    funded = live_coins(escrow_script)
                    step("escrow funded", coins=funded)
                    renewed = until("delegate renews the escrow", lambda: (c if (c := [x for x in live_coins(escrow_script)
                                    if x[0] not in {f[0] for f in funded}]) else None), a.renew_after_secs + 900)
                    locked = renewed[0][1]
                    step("escrow renewed", coins=renewed, fee_sats=CAP - locked,
                         registered=first(seller_log, "renewal_registered", job_id=job1["job_id"]))

                # 2. Paid requests, each receipted.
                served = []
                for _ in range(3):
                    status, body = chat(api)
                    assert status == 200, (status, body)
                    served.append({"content": body["choices"][0]["message"]["content"], "usage": body.get("usage")})
                step("paid requests", served=served)
                receipts = until("three receipts accepted", lambda: (r if len(r := [e for e in events(seller_log)
                                 if e["event"] == "receipt_accepted" and e["job_id"] == job1["job_id"]]) >= 3 else None), 30)
                billed = [e for e in events(seller_log) if e["event"] == "billed" and e["job_id"] == job1["job_id"]]
                step("receipts", amounts=[r["amount_sats"] for r in receipts], seller_usage_sats=[r["usage_sats"] for r in receipts],
                     reservations_released=[b["reservation_released"] for b in billed])
                # The seller priced each request from its real body, not from the configured ceiling.
                admitted = [e for e in events(seller_log) if e["event"] == "admitted" and e["job_id"] == job1["job_id"]]
                step("admission", has_body=[e["has_body"] for e in admitted], reserved_msat=[e["reserved_msat"] for e in admitted])
                assert admitted and all(e["has_body"] for e in admitted), admitted
                owed = receipts[-1]["amount_sats"]
                assert owed >= 330, owed

                # 3. The provider claims the latest receipt before the deadline; the rest goes home.
                claim = until("seller claims job 1", lambda: first(seller_log, "claimed", job_id=job1["job_id"]),
                              job1["deadline"] - time.time() + 30)
                step("claimed", txid=claim["txid"], paid_sats=claim["paid_sats"], returned_sats=claim["returned_sats"])
                assert claim["paid_sats"] == owed and claim["returned_sats"] == locked - owed, claim
                if claim["returned_sats"]:
                    until("treasury holds the remainder", lambda: locked - owed in balances(treasury["pkScript"]), 60)
                if payout:
                    until("earnings reached the payout address", lambda: owed in balances(payout["pkScript"]), 60)
                until("buyer sees the close", lambda: first(buyer_log, "job_closed", job_id=job1["job_id"]), 30)

                # 4. A second job, funded and never used, is returned whole after its deadline.
                status, body = chat(api)
                step("request after close opens job 2", status=status)
                job2 = fund(2)
                expired = until("buyer returns job 2", lambda: first(buyer_log, "expired", job_id=job2["job_id"]),
                                job2["deadline"] - time.time() + GRACE + 60)
                step("expired", txid=expired["txid"], returned_sats=expired["returned_sats"])
                # With early renewal on, the delegate service may have renewed job 2 first, at most for the fee cap.
                renewal_fee_cap = 100 if a.renew_after_secs else 0
                assert CAP - renewal_fee_cap <= expired["returned_sats"] <= CAP, expired
                # 5. Funding that lands after the provider gave up on a job is still returned, after its deadline.
                wanted = [locked - owed, expired["returned_sats"]]
                if regtest:
                    status, body = chat(api)
                    step("request after expiry opens job 3", status=status)
                    request = until("funding request 3", lambda: (events(queue)[2] if len(events(queue)) >= 3 else None), 60)
                    # The provider stops waiting for funding MARGIN seconds before the deadline; fund after that.
                    time.sleep(max(0.0, request["deadline"] - MARGIN + 5 - time.time()))
                    faucet(request["address"], request["cap_sats"])
                    step("keepers funded job 3 late", job_id=request["job_id"], deadline_in=request["deadline"] - int(time.time()))
                    late = until("buyer returns late-funded job 3", lambda: first(buyer_log, "expired", job_id=request["job_id"]),
                                 request["deadline"] - time.time() + GRACE + 60)
                    step("late funding returned", txid=late["txid"], returned_sats=late["returned_sats"])
                    assert late["returned_sats"] == CAP, late
                    assert not first(buyer_log, "job_open", job_id=request["job_id"]), "a late-funded job was opened"
                    wanted.append(CAP)
                final = until("treasury holds every return",
                              lambda: (b if contains(b := balances(treasury["pkScript"]), wanted) else None), 60)
                step("treasury", balances=final)
            result["passed"] = True
        except BaseException as e:
            result["passed"] = False
            result["error"] = repr(e)
            raise
        finally:
            for node in reversed(nodes):
                node.stop()
            (a.out / "result.json").write_text(json.dumps(result, indent=2))
    print("PASSED" if result.get("passed") else "FAILED")


if __name__ == "__main__":
    main()
