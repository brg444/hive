"""Hardening gate: what the happy path does not exercise.

On the local Arkade stack, with a provider and the hive's agent:
  A. A streamed answer: is it paid, and does the receipt include its tokens?
  B. Several requests at once on one job: every answer paid, the final receipt equal to the bill.
  C. The provider's node restarts in the middle of a job: the job and its receipts survive, serving
     resumes, and the provider still claims the latest receipt.
  D. The agent's node restarts in the middle of a job: receipts continue from the running total.
"""
import json, sys, tempfile, threading, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_gate as g

PERIOD, MARGIN = 140, 40  # regtest coins live about three minutes; this leaves 100 s to serve


def stream_chat(api, include_usage):
    """A streamed request: returns (status, the raw event stream)."""
    request = {"model": g.MODEL_ID, "messages": [{"role": "user", "content": "Name a color."}],
               "temperature": 0, "max_tokens": 12, "stream": True}
    if include_usage:
        request["stream_options"] = {"include_usage": True}
    body = json.dumps(request).encode()
    req = urllib.request.Request(api + "/chat/completions", data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main():
    out = g.ROOT / "gate/out-hardening"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*"):
        f.unlink()
    mesh = g.mesh_default()
    model = g.model_default()
    plugin, worker = g.ROOT / "plugin/target/debug/pay-arkade", g.ROOT / "worker/dist/pay-arkade-worker"
    result = {"steps": []}

    def step(name, **detail):
        result["steps"].append({"step": name, **detail})
        print(f"- {name}: {json.dumps(detail)}", flush=True)

    with tempfile.TemporaryDirectory(prefix="pay-arkade-hardening-") as tmp:
        tmp = Path(tmp)
        treasury = g.worker_call(worker, tmp / "treasury.key", [], "info")
        seller_log, buyer_log, queue = out / "seller.jsonl", out / "buyer.jsonl", out / "funding-queue.jsonl"
        common = ["--worker", str(worker), "--model", g.MODEL_ID, "--close-margin-secs", str(MARGIN), "--min-coin-life-secs", "30"]
        homes = {"provider": tmp / "provider", "agent": tmp / "agent"}
        for h in homes.values():
            (h / ".mesh-llm").mkdir(parents=True)
        (homes["provider"] / ".mesh-llm/config.toml").write_text(g.plugin_block(plugin, [
            "--role", "seller", *common, "--state-dir", str(tmp / "seller"), "--log", str(seller_log),
            "--price-msat-per-mtok", str(g.PRICE), "--max-unreceipted-sats", "3000"]))
        (homes["agent"] / ".mesh-llm/config.toml").write_text(g.plugin_block(plugin, [
            "--role", "buyer", *common, "--state-dir", str(tmp / "buyer"), "--log", str(buyer_log),
            "--treasury-program", treasury["program"], "--funding-queue", str(queue), "--cap-sats", "20000",
            "--period-secs", str(PERIOD), "--max-price-msat-per-mtok", str(g.PRICE)]))
        ports = g.free_ports(4)
        # The hive's agent hosts the mesh, and the provider joins it through a file it re-reads on
        # every rejoin, so an agent that restarts on a new port can hand out its new invite.
        join_file = tmp / "hive-invite.txt"
        agent_args = ["--port", str(ports[2]), "--console", str(ports[3])]
        provider_args = ["--gguf", str(model), "--join-file", str(join_file), "--port", str(ports[0]), "--console", str(ports[1])]
        nodes = {}
        try:
            nodes["agent"] = g.Node(mesh, homes["agent"], out / "agent-node.log", agent_args)
            join_file.write_text(nodes["agent"].invite())
            nodes["provider"] = g.Node(mesh, homes["provider"], out / "provider-node.log", provider_args)
            g.until("seller terms", lambda: g.first(seller_log, "terms_published"), 180)
            api = f"http://127.0.0.1:{ports[2]}/v1"

            def visible():
                status, body = g.http(api + "/models", timeout=5)
                return status == 200 and any(m["id"] == g.MODEL_ID for m in body.get("data", []))
            g.until("model visible to the agent", visible, 300)

            def open_job(n):
                g.chat(api)  # refused; opens the job
                request = g.until(f"funding request {n}", lambda: (g.events(queue)[n - 1] if len(g.events(queue)) >= n else None), 60)
                g.faucet(request["address"], request["cap_sats"])
                g.until(f"job {n} open", lambda: g.first(buyer_log, "job_open", job_id=request["job_id"]) and g.first(seller_log, "job_open", job_id=request["job_id"]), 60)
                return request

            def receipts(job_id):
                return [e["amount_sats"] for e in g.events(seller_log) if e["event"] == "receipt_accepted" and e["job_id"] == job_id]

            def billed(job_id):
                return sum(e["usage_msat"] - prev for prev, e in zip([0] + [b["usage_msat"] for b in bills(job_id)][:-1], bills(job_id)))

            def bills(job_id):
                return [e for e in g.events(seller_log) if e["event"] == "billed" and e["job_id"] == job_id]

            # ---- Job 1: streaming, concurrency, provider restart ----
            job1 = open_job(1)

            # A. Streamed answers: refused unless they ask for usage, and paid when they do.
            status, _ = stream_chat(api, include_usage=False)
            step("A. stream without usage", status=status)
            assert status != 200, "a stream that would go unpaid is refused"
            status, stream = stream_chat(api, include_usage=True)
            usage_lines = [l for l in stream.splitlines() if '"usage"' in l and '"prompt_tokens"' in l]
            time.sleep(2)
            step("A. stream with usage", status=status, stream_reports_usage=bool(usage_lines),
                 seller_billed=[b["tokens"] for b in bills(job1["job_id"])], receipts=receipts(job1["job_id"]))
            assert status == 200 and bills(job1["job_id"]) and receipts(job1["job_id"]), "the streamed answer is billed and receipted"

            # B. Four requests at once on the same job. MeshLLM 0.79 sometimes fails a burst of
            # concurrent requests with a retryable 503 before any token is generated; a client retries
            # those, as OpenAI clients do, and what matters here is that every answer is paid once.
            def with_retries(answers, tries):
                for attempt in range(4):
                    status = g.chat(api)[0]
                    tries.append(status)
                    if status != 503:
                        break
                    time.sleep(1 + attempt)
                answers.append(status)
            answers, tries = [], []
            threads = [threading.Thread(target=with_retries, args=(answers, tries)) for _ in range(4)]
            [t.start() for t in threads]
            [t.join() for t in threads]
            time.sleep(3)
            r = receipts(job1["job_id"])
            last_bill = bills(job1["job_id"])[-1]["usage_msat"] if bills(job1["job_id"]) else 0
            step("B. four at once", statuses=sorted(answers), retried_503s=tries.count(503), receipts=r,
                 seller_usage_sats=-(-last_bill // 1000))
            assert answers.count(200) == 4, answers
            assert len(bills(job1["job_id"])) == 1 + 4, "each answer billed once, refused attempts never"
            assert r and r[-1] == -(-last_bill // 1000), "the latest receipt equals the provider's bill"

            # C. The provider's node restarts mid-job.
            before = receipts(job1["job_id"])[-1]
            nodes["provider"].stop()
            nodes["provider"] = g.Node(mesh, homes["provider"], out / "provider-node-2.log", provider_args)
            g.until("provider back with its terms", lambda: len([e for e in g.events(seller_log) if e["event"] == "terms_published"]) >= 2, 180)
            g.until("model visible again", visible, 180)
            status = g.until("served after the provider's restart", lambda: (s if (s := g.chat(api)[0]) == 200 else None), 60)
            time.sleep(2)
            after = receipts(job1["job_id"])[-1]
            step("C. provider restarted mid-job", status=status, receipt_before=before, receipt_after=after)
            assert after > before, "receipts continue after the restart"
            claim = g.until("claim after the restart", lambda: g.first(seller_log, "claimed", job_id=job1["job_id"]), job1["deadline"] - time.time() + 30)
            step("C. claimed", paid=claim["paid_sats"], latest_receipt=receipts(job1["job_id"])[-1])
            assert claim["paid_sats"] == receipts(job1["job_id"])[-1]
            g.until("buyer sees the close", lambda: g.first(buyer_log, "job_closed", job_id=job1["job_id"]), 30)

            # ---- Job 2: the agent restarts mid-job ----
            job2 = open_job(2)
            assert g.chat(api)[0] == 200
            time.sleep(2)
            before = receipts(job2["job_id"])[-1]
            nodes["agent"].stop()
            nodes["agent"] = g.Node(mesh, homes["agent"], out / "agent-node-2.log", agent_args)
            join_file.write_text(nodes["agent"].invite())  # the hive publishes its current invite
            g.until("model visible to the restarted agent", visible, 240)
            status = g.until("served after the agent's restart", lambda: (s if (s := g.chat(api)[0]) == 200 else None), 60)
            time.sleep(2)
            after = receipts(job2["job_id"])[-1]
            step("D. agent restarted mid-job", status=status, receipt_before=before, receipt_after=after)
            assert after > before, "the running total survives the agent's restart"
            claim = g.until("claim of job 2", lambda: g.first(seller_log, "claimed", job_id=job2["job_id"]), job2["deadline"] - time.time() + 30)
            step("D. claimed", paid=claim["paid_sats"], returned=claim["returned_sats"])
            assert claim["paid_sats"] == after
            result["passed"] = True
        except BaseException as e:
            result["passed"] = False
            result["error"] = repr(e)
            raise
        finally:
            for n in nodes.values():
                n.stop()
            (out / "result.json").write_text(json.dumps(result, indent=2))
    print("PASSED" if result.get("passed") else "FAILED")


if __name__ == "__main__":
    main()
