"""Gateway gate: a member spends the hive's budget from their own node, within an allowance.

Three MeshLLM 0.79 nodes on a local Arkade stack: a provider (seller), the hive's agent (buyer, with
a members file) and a member (member role, no keys). The member's tools call the model `hive` on the
member's own node; the plugin forwards each request to the agent over the peer channel, and the
agent runs it through its own node, so it is paid and receipted like any other request.
"""
import base64, json, os, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_gate as g  # shared helpers: nodes, plugin blocks, faucet, http, events

ALLOWANCE = 1000  # sats a day: three answers at ~460 sats fit, the fourth is refused


def node_id(node):
    token = node.invite()
    return json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))["id"]


def main():
    out = g.ROOT / "gate/out-gateway"
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

    with tempfile.TemporaryDirectory(prefix="pay-arkade-gateway-") as tmp:
        tmp = Path(tmp)
        treasury = g.worker_call(worker, tmp / "treasury.key", [], "info")
        seller_log, buyer_log, member_log = out / "seller.jsonl", out / "buyer.jsonl", out / "member.jsonl"
        queue, members = out / "funding-queue.jsonl", out / "members.json"
        members.write_text(json.dumps({"members": {}}))
        common = ["--worker", str(worker), "--model", g.MODEL_ID, "--close-margin-secs", "40", "--min-coin-life-secs", "30"]
        homes = {n: tmp / n for n in ("provider", "agent", "member")}
        for h in homes.values():
            (h / ".mesh-llm").mkdir(parents=True)
        (homes["provider"] / ".mesh-llm/config.toml").write_text(g.plugin_block(plugin, [
            "--role", "seller", *common, "--state-dir", str(tmp / "seller"), "--log", str(seller_log),
            "--price-msat-per-mtok", str(g.PRICE), "--max-unreceipted-sats", "2000"]))
        (homes["agent"] / ".mesh-llm/config.toml").write_text(g.plugin_block(plugin, [
            "--role", "buyer", *common, "--state-dir", str(tmp / "buyer"), "--log", str(buyer_log),
            "--treasury-program", treasury["program"], "--funding-queue", str(queue), "--cap-sats", "20000",
            "--period-secs", "100", "--max-price-msat-per-mtok", str(g.PRICE), "--members-file", str(members)]))
        ports = g.free_ports(6)
        nodes = []
        try:
            provider = g.Node(mesh, homes["provider"], out / "provider-node.log", ["--gguf", str(model), "--port", str(ports[0]), "--console", str(ports[1])])
            nodes.append(provider)
            g.until("seller terms", lambda: g.first(seller_log, "terms_published"), 180)
            invite = provider.invite()
            agent = g.Node(mesh, homes["agent"], out / "agent-node.log", ["--join", invite, "--port", str(ports[2]), "--console", str(ports[3])])
            nodes.append(agent)
            agent_id = node_id(agent)
            # A member's plugin holds no keys and needs no exchange grant: a plain entry.
            member_args = ", ".join(json.dumps(a) for a in ["--role", "member", "--agent", agent_id, "--log", str(member_log)])
            (homes["member"] / ".mesh-llm/config.toml").write_text(
                f'[[plugin]]\nname = "pay-arkade"\ncommand = {json.dumps(str(plugin))}\nargs = [{member_args}]\n')
            member = g.Node(mesh, homes["member"], out / "member-node.log", ["--join", invite, "--port", str(ports[4]), "--console", str(ports[5])])
            nodes.append(member)
            member_id = node_id(member)
            step("nodes", agent=agent_id[:12], member=member_id[:12])
            api = f"http://127.0.0.1:{ports[4]}/v1"

            def chat(model_id):
                return g.http(api + "/chat/completions", {"model": model_id, "messages": [{"role": "user", "content": "Name a color."}],
                                                          "temperature": 0, "max_tokens": 12, "stream": False}, timeout=180)

            # The hive appears as a model on the member's own node.
            def hive_listed():
                status, body = g.http(api + "/models", timeout=5)
                return body if status == 200 and any(m["id"] == "hive" for m in body.get("data", [])) else None
            models = g.until("hive model on the member's node", hive_listed, 120)
            step("member's models", ids=[m["id"] for m in models["data"]])

            # Not yet a member: refused by the agent.
            status, body = chat("hive")
            step("before joining the members file", status=status, body=body)
            assert status == 403 and member_id in body["error"]["message"], (status, body)

            members.write_text(json.dumps({"model": g.MODEL_ID, "members": {member_id: {
                "name": "alice", "proposal": "p-test", "allowance_sats_per_day": ALLOWANCE}}}))
            # The first request finds no open job: the agent offers one, and the keepers fund it.
            status, body = chat("hive")
            step("first request, no job yet", status=status)
            assert status != 200, body
            request = g.until("funding request", lambda: (g.events(queue)[0] if g.events(queue) else None), 60)
            g.faucet(request["address"], request["cap_sats"])
            g.until("job open", lambda: g.first(buyer_log, "job_open", job_id=request["job_id"]), 60)
            g.until("job open on the seller", lambda: g.first(seller_log, "job_open", job_id=request["job_id"]), 60)

            served = []
            for _ in range(3):
                status, body = chat("hive")
                assert status == 200, (status, body)
                served.append(body.get("usage"))
            step("member's paid requests", usage=served)
            status, body = chat("hive")
            step("over the allowance", status=status, body=body)
            assert status == 429, (status, body)

            # Calling the provider's model directly bypasses the hive: the provider refuses it.
            status, body = chat(g.MODEL_ID)
            step("direct call to the provider", status=status)
            assert status in (402, 403, 503), (status, body)

            usage = [e for e in g.events(buyer_log) if e["event"] == "member_usage" and e["status"] == 200]
            receipts = g.until("three receipts", lambda: (r if len(r := [e for e in g.events(seller_log) if e["event"] == "receipt_accepted"]) >= 3 else None), 30)
            step("attribution", member_msat=[e["msat"] for e in usage], proposal={e["proposal"] for e in usage} == {"p-test"},
                 receipts=[r["amount_sats"] for r in receipts])
            assert len(usage) == 3 and all(e["member"] == member_id and e["priced"] for e in usage)
            assert sum(e["msat"] for e in usage) // 1000 == receipts[-1]["amount_sats"], "member usage matches what the provider was paid"
            result["passed"] = True
        except BaseException as e:
            result["passed"] = False
            result["error"] = repr(e)
            raise
        finally:
            for n in reversed(nodes):
                n.stop()
            (out / "result.json").write_text(json.dumps(result, indent=2, default=list))
    print("PASSED" if result.get("passed") else "FAILED")


if __name__ == "__main__":
    main()
