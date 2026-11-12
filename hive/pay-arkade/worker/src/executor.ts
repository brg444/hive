// Renewal by the executor (arkade-os/executor): it renews each escrow coin before its batch expires
// through the contract's `renew` function, so an escrow outlives any batch. The escrow's artifact and
// its renewal template are registered once per executor; each job then registers a delegation for
// its escrow address, which ends shortly after the job's deadline.
import { hex } from "@scure/base";
import artifact from "../../contracts/job_escrow.artifact.json" with { type: "json" };
import renewTemplate from "../../contracts/executor/renew.template.json" with { type: "json" };
import { NO_DELEGATE, type Escrow, type EscrowParams } from "./escrow.ts";
import { ownersKey } from "./musig.ts";
import { hexBytes } from "./signing.ts";

/** Minimal Script-number bytes, little-endian with a sign bit, as a template binds an int. */
export function scriptNum(n: number | bigint): Uint8Array {
    let v = BigInt(n);
    if (v === 0n) return new Uint8Array();
    const neg = v < 0n;
    if (neg) v = -v;
    const out: number[] = [];
    while (v > 0n) {
        out.push(Number(v & 0xffn));
        v >>= 8n;
    }
    if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0);
    else if (neg) out[out.length - 1] |= 0x80;
    return Uint8Array.from(out);
}

export class Executor {
    constructor(readonly url: string) {}

    private async call(method: "GET" | "POST", path: string, body?: unknown) {
        const res = await fetch(`${this.url.replace(/\/+$/, "")}${path}`, {
            method,
            headers: body ? { "content-type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`executor ${path}: ${res.status} ${text.slice(0, 300)}`);
        return JSON.parse(text);
    }

    /** Register the escrow's artifact and its renewal template; both are content-addressed, so repeating is harmless. */
    async setup() {
        const art = await this.call("POST", "/v1/artifact", { document: JSON.stringify(artifact) });
        const artifactId: string = art.artifact.id;
        const doc = JSON.parse(JSON.stringify(renewTemplate));
        doc.inputs[0].contract.definition.artifact = artifactId;
        const tpl = await this.call("POST", "/v1/template", { document: JSON.stringify(doc) });
        return { artifactId, templateId: tpl.template.id as string, status: tpl.template.status as string };
    }

    /** The template's variables for one job, in the executor's lower-case hex. */
    variables(escrow: Escrow, params: EscrowParams) {
        const r = escrow.renewal(params);
        const h = (b: Uint8Array) => hex.encode(b);
        return {
            // The executor takes compressed keys; an x-only key is the even-y point, prefix 02.
            agent_pk: "02" + h(hexBytes(params.agentPk, 32, "agentPk")),
            provider_pk: "02" + h(hexBytes(params.providerPk, 32, "providerPk")),
            treasury_program: h(hexBytes(params.treasuryProgram, 32, "treasuryProgram")),
            deadline: h(scriptNum(params.deadline)),
            job_id: h(hexBytes(params.jobId, 32, "jobId")),
            renewal_window: h(scriptNum(r.renewalWindow)),
            max_fee: h(scriptNum(r.maxRenewalFee)),
            exit_delay: h(scriptNum(escrow.exitDelay())),
            delegate_pk: "02" + h(hexBytes(params.delegatePk ?? NO_DELEGATE, 32, "delegatePk")),
            owners_pk: "02" + h(ownersKey(params.agentPk, params.providerPk).xonly),
        };
    }

    /**
     * Ask the executor to keep this job's escrow renewed until `expiresAt`. The executor derives the
     * escrow's address from the template and the variables; it must be the address the job funds.
     */
    async register(escrow: Escrow, params: EscrowParams, templateId: string, expiresAt: number) {
        const res = await this.call("POST", "/v1/delegation", {
            template_id: templateId,
            variables: this.variables(escrow, params),
            expires_at: String(expiresAt),
        });
        const d = res.delegation;
        const expected = escrow.address(params).address;
        if (d.address !== expected) throw new Error(`executor derived ${d.address}, the job funds ${expected}`);
        return { id: Number(d.id), address: d.address as string, status: d.status as string, expiresAt: Number(d.expiresAt ?? d.expires_at) };
    }

    /** The delegation for an escrow address, if any, and the coins the executor sees there. */
    async status(address: string) {
        try {
            const res = await this.call("GET", `/v1/delegation?address=${encodeURIComponent(address)}`);
            const d = res.delegation;
            return {
                registered: true,
                status: d.status as string,
                expiresAt: Number(d.expiresAt ?? d.expires_at),
                coins: (res.coins ?? []).map((c: Record<string, unknown>) => ({ outpoint: c.outpoint, amount: Number(c.amount), expiresAt: Number(c.expiresAt ?? c.expires_at) })),
            };
        } catch (e) {
            if (String(e).includes(" 404 ")) return { registered: false };
            throw e;
        }
    }
}
