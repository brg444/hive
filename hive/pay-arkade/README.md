# pay-arkade

A MeshLLM plugin that lets a model be paid for in Bitcoin on Arkade. A provider
gates a model behind `pay.arkade.v1` terms; a buyer opens a job by funding an
escrow up to a cap, signs a cumulative receipt after each answer, and the
provider closes the job by claiming what the latest receipt says. Whatever is
not claimed goes back to the treasury that funded it, at once on claim or after
the job's deadline.

The plugin has two halves that ship together in one plugin archive:

- `plugin/` is the MeshLLM side, in Rust, because MeshLLM's plugin protocol has
  only a Rust crate. It gates the model, publishes terms, answers 402, speaks
  the peer channel, reads token usage when an answer finishes, and keeps each
  job's state. It holds no keys.
- `worker/` is the Arkade side, in TypeScript on the Arkade SDK, compiled with
  Bun into one executable. The plugin starts it and talks to it over JSON lines
  on stdin and stdout. It holds the one key a node needs (the provider's claim
  key, or the buyer's receipt key), signs quotes and receipts, derives escrow
  addresses, and makes the claim and expiry spends.
- `contracts/` holds the escrow contract, its compiled artifact and the
  contract's own end-to-end test.

## The escrow

`contracts/job_escrow.ark` takes the agent's receipt key, the provider's key, the treasury's taproot
program, a deadline, a job id, the renewal terms (a window and a fee cap), the Arkade server's exit
delay, the delegate service's key and the MuSig2 aggregate of the agent's and the provider's keys.
Every argument is stated, so the escrow's script follows from its arguments alone. Its paths:

- `claim` with a receipt `sha256(jobId ‖ le64(amount))` signed by the agent. The provider takes what
  the receipt owes; a remainder above 330 sats must go to the treasury first. A remainder at or below
  330 cannot be its own output, so the provider takes the coin whole, as it does when renewal fees
  left less locked than the receipt owes.
- `expire`, open to anyone after the deadline, returns the coin whole to the treasury.
- `renew`, open to anyone within the renewal window before the coin's batch expires, recreates the
  same escrow in a new batch: the same script, the same value less at most the fee cap, in a register
  proof with no onchain output. The executor (arkade-os/executor) runs it, so an escrow outlives any
  batch.
- `cooperative`, the agent and the provider together through their aggregate key, and `delegate`,
  the same plus the delegate service: a delegated renewal's proof is signed on the first and its
  forfeit on the second.
- `unilateral`, agent and provider together after the exit delay, for when the Arkade server is gone.

`contracts/templates/` holds one `template/v1` document per path, in the Arkade template format, with
the artifact they reference; they pass the format's own schema check (`check.py`). `contracts/executor/renew.template.json` is the same renewal in the format executord
accepts today, which the worker registers.

## Renewal

Mainnet batches last about a month, and an escrow funded from an older coin inherits its expiry. An
escrow is kept alive the way the Arkade wallet keeps its own coins alive: through the delegate service
(`delegate.arkade.money` on mainnet, `--delegate <url>`), which submits a presigned renewal shortly
before the coin expires, joins the batch as a cosigner and renews the escrow into itself. The service
accepts exactly one owner signature, so the agent and the provider sign as one MuSig2 key:

1. Once the escrow is funded, the provider builds the renewal (a register proof spending the escrow's
   coin into the same escrow, less the service's fee, and the forfeit for the delegate path) and sends
   it with its MuSig2 nonces.
2. The agent checks that it renews this escrow's coin into this escrow, through the job's delegate,
   for no more than the escrow's fee cap and timed to the coin's expiry, and answers with its nonces
   and partial signatures.
3. The provider completes the signatures, submits the renewal to the service, and only then opens
   the job.

The quote names the delegate service's key, and the agent accepts only the service it is configured
with. Both sides need `--delegate`; `install-provider.sh` sets it on mainnet unless told
`--delegate none`. Without it, the provider requires the escrow coin to outlive the deadline by
`--min-coin-life-secs` instead.

The executor (arkade-os/executor) is the second route, for when it runs on mainnet. With `--executor <url>` on both sides, the buyer's worker registers the escrow's artifact and its
renewal template with the executor once, and each job's renewal before keepers are asked to fund it,
lasting until an hour after the job's return. The funding request then names the renewal instead of a
minimum coin expiry, and the provider opens a job only when the executor reports the renewal active.
Without an executor, the provider instead requires the escrow coin to outlive the deadline by
`--min-coin-life-secs`.

Renewal terms default per network (two days and 100 sats on mainnet, 90 seconds on regtest, where
coins live minutes); mainnet charges no fee to renew a coin close to its expiry, so the cap is a
margin. Both sides derive the escrow's address from the same terms.

## Worker protocol

Requests are `{"id": n, "op": "...", ...}`; each gets `{"id": n, "ok": {...}}`
or `{"id": n, "error": "..."}`, not necessarily in order. Escrow terms travel
as `params`: `{agentPk, providerPk, treasuryProgram, deadline, jobId}`, keys
and hashes in hex, the deadline in unix seconds, with optional `renewalWindow` and `maxRenewalFee`
(the network's defaults otherwise) and `delegatePk` (none otherwise).

| op | takes | returns |
| --- | --- | --- |
| `ping` | | `pubkey` (works with no operator) |
| `info` | | `pubkey`, `address`, `pkScript`, `program` of this key's own address |
| `escrow` | `params` | the job's `address` and `pkScript` |
| `escrow_status` | `params` | `coins`, `open`, `lockedSats` |
| `sign_quote` / `verify_quote` | `quote` (and `providerPk`, `sig`) | `sig` / `valid` |
| `sign_receipt` / `verify_receipt` | `jobId`, `amountSats` (and `agentPk`, `sig`) | `sig` / `valid` |
| `claim` | `params`, `amountSats`, `agentSig`, optional `payoutPkScript` | `txid`, `paidSats`, `returnedSats` |
| `expire` | `params` | `txid`, `returnedSats` |
| `renewal_setup` | | `artifactId`, `templateId`, `status` (needs `--executor`) |
| `renewal_register` | `params`, `templateId`, `expiresAt` | the delegation's `id`, `address`, `status` |
| `renewal_status` | `params` | `registered`, `status`, `expiresAt`, the coins the executor sees |
| `delegate_info` | | the delegate service's `pubkey`, `xonly`, `fee`, `address` (needs `--delegate`) |
| `renewal_prepare` | `params` | the unsigned renewal and the provider's nonces |
| `renewal_cosign` | `params`, `request` | the agent's nonces and partial signatures, after its checks |
| `renewal_finish` | `params`, `answer` | completes the signatures, submits to the service: `validAt` |

Quotes are signed over `sha256("pay.arkade.v1/quote:" + canonical JSON)`, keys
sorted at every level, so either side can rebuild the digest.

```bash
pay-arkade-worker --key-file <path> [--operator URL] [--emulator URL] [--network regtest] [--executor URL] [--delegate URL]
```

The key file holds a 32-byte hex secret and is created with mode 600 if it is
missing.

## Running the plugin

Each node lists the plugin in its MeshLLM config with a lifecycle grant. The seller needs
`request_received` and `exchange_finished`; the buyer `backend_selected` and `exchange_finished`.
One block serves both:

```toml
[[plugin]]
name = "pay-arkade"
command = "/path/to/pay-arkade"          # pay-arkade-worker sits beside it, or pass --worker
args = ["--role", "seller", "--model", "<model id>", "--state-dir", "/path/to/state"]

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
```

Both roles take `--model` (repeatable), `--state-dir` (the job book and, unless `--key-file` says
otherwise, the key), `--log` (JSON lines), `--worker`, `--operator`, `--emulator` and `--network`.

A seller also takes `--price-msat-per-mtok`, `--min-cap-sats`, `--max-cap-sats`,
`--max-deadline-secs`, `--close-margin-secs` (it stops admitting and claims this long before a
deadline), `--max-unreceipted-sats` (how far usage may run ahead of the latest receipt),
`--default-max-tokens` (the token count it assumes for a prompt or an answer when the request
does not say) and `--payout-pk-script`.

A seller reserves each request's worst case against the escrow before admitting it: the prompt
at three bytes a token plus the request's own output limit, priced at its rate. MeshLLM streams
the request body to the plugin before the hook runs, which is why the grant needs
`request_body = true`.

A streamed request is sold only if it sets `stream_options.include_usage`: MeshLLM reports a
stream's token usage to the plugin only when the client asks for it, so the seller refuses any
other stream with a 402 that says what to add, rather than serve an answer it cannot bill.

A buyer also takes `--treasury-program` (required: where every return goes), `--cap-sats` and
`--period-secs` (each job's size and life), `--max-price-msat-per-mtok`, `--funding-queue` (one
JSON line per job for the keepers to fund) and `--expire-grace-secs`.

The buyer never holds treasury keys. It writes each agreed job to the funding queue; the keepers
move exactly the cap to the escrow address; both plugins see the coin and open the job.

## The hive's members

A hive's members use its budget from their own nodes, with no key and no wallet. A member's node runs
the plugin with `--role member --agent <the hive agent's node id>` and no exchange grant; it then
offers a model named `hive` (or `--hive-model`) to any OpenAI-compatible tool pointed at the node,
streaming included. Each request travels over the peer channel to the hive's agent, which checks the
sender against its members file and runs the request through its own node, where the buyer's hooks
route it to a provider with an open job and receipt it like any other. The member gets the answer, or
a refusal that says why: 403 with the node id to give the keepers when it is not a member, 429 when
the day's allowance is spent.

The agent reads the members file named by `--members-file` on every request, so the coordinator's
edits apply at once:

```json
{
  "model": "<default model id>",
  "members": {
    "<member node id>": {"name": "ana", "proposal": "p-12", "allowance_sats_per_day": 2000}
  }
}
```

An entry may name its own `model`. What each member has spent today is kept in `usage.json` in the
agent's state directory, so a restart does not reset it. The agent logs one `member_usage` line per
request with the member, the proposal, the tokens and what they cost at the served job's quoted
price; prompts and answers are never logged. hive-api adds these up per proposal.

`packaging/install-member.sh --archive <archive> --agent <node id>` sets a member up in one step.

## Operations

MeshLLM has no fixed mesh port: a node that restarts listens on a new one, and invites name the
address. The hive's agent therefore hosts the mesh and providers join with `--join-file <path>`,
which MeshLLM re-reads on every rejoin. hive-api can serve the agent's current invite
(`--agent-console` with `--serve-invite`), and `hive-join-sync.sh --url
https://<hive host>/hive/v1/invite` (shipped in the archive), run every minute, keeps a provider's or member's join file
current with it. Unless the mesh admits only trusted owners, anyone holding the invite can join it,
though joining alone buys nothing: providers and buyers deal only with the peers they name, and the
agent serves only listed members. Jobs, receipts and members' usage are on
disk on both sides, so either node restarting mid-job loses nothing: serving resumes and the
provider still claims the latest receipt.

## Mainnet

Mainnet runs on `https://arkade.computer`, with the emulator URL each hive gives its providers
(`--emulator`; both passed the worker's preflight on November 12), and stays gated:

- **Named peers.** `--allow-peer <node id>` (repeatable) lists the mesh peers a node deals with: the
  buyers a seller quotes, the providers a buyer pays. On `--network bitcoin` a node with no list
  refuses to start unless given `--allow-any-peer`.
- **Exposure cap.** A buyer never has more than `--max-open-sats` (default 100,000) committed across
  jobs not yet settled; past it, it opens no new job.
- **Coin life.** Arkade sweeps a coin when its batch expires, and an escrow cannot be returned
  before its deadline. A seller opens a job only if the escrow coin outlives the deadline by
  `--min-coin-life-secs` (default one day), and each funding request tells the keepers the
  earliest expiry it accepts.
- **Late funding.** An escrow funded after the provider stopped waiting is never opened, and the
  buyer returns it after the deadline.
- **Preflight.** The worker's `preflight` op checks that the operator is on the expected network,
  charges no offchain fee (claims and returns pay out every sat) and serves the emulator key the
  SDK expects. `install-provider.sh` runs it before writing any config.

The worker's `address_info` op turns an Arkade address on the same operator into the taproot
program a buyer's `--treasury-program` and a seller's `--payout-pk-script` take.

## Packaging and provider install

`packaging/build.sh` builds both halves for the machine it runs on and packages them as a MeshLLM
plugin archive, `dist/pay-arkade-<version>-<os>-<arch>.tar.gz`, with a checksum beside it. The
archive holds the plugin, the worker, the generated plugin manifest and the escrow contract's
source.

A provider then needs MeshLLM 0.79 or later, the archive and one script:

```bash
packaging/install-provider.sh --archive pay-arkade-0.1.0-linux-x86_64.tar.gz \
    --gguf model.gguf --price-msat-per-mtok 2000000 --operator https://<arkade operator>
```

It installs the plugin into MeshLLM's plugin store, creates the claim key in
`~/.mesh-llm/pay-arkade` (outside the store, so reinstalling never touches the key or unpaid
receipts), adds a `[[plugin]]` entry gating the model, checks it with `mesh-llm config validate`,
and prints the claim key, the address earnings go to, and the `mesh-llm serve` command that joins
the hive's mesh. The entry names the installed executable by path, which makes the plugin required:
a node whose plugin cannot start does not start, so it never serves the model ungated. Arguments
after `--` go to the plugin unchanged.

## Build and test

```bash
cd worker && bun install && bun run build      # dist/pay-arkade-worker
cd plugin && cargo build --release
```

The end-to-end tests run against a local Arkade stack with the emulator, from
`ArkLabsHQ/arkade-regtest`:

```bash
git clone --depth 1 https://github.com/ArkLabsHQ/arkade-regtest.git regtest
printf 'AUTOMINE_INTERVAL=0\n' > .env.regtest
node regtest/regtest.mjs start --env .env.regtest --profile ark --profile emulator
docker exec arkd arkd fees clear     # the faucet redeems notes, which pay no intent fee
cd worker && bun x vitest run
```

The phase 2 gate runs two MeshLLM 0.79 nodes against the same stack. It needs a MeshLLM release
bundle and a small GGUF model (paths are flags), and plays the keepers by funding each job in the
buyer's queue from the regtest faucet. It checks that a paid job is claimed for its latest receipt
with the rest returned to the treasury, and that an unused job is returned whole after its deadline:

```bash
cd plugin && cargo build && cd ..
python3 gate/run_gate.py --mesh <mesh-llm binary> --model <model.gguf>
```

With `--provider-archive dist/pay-arkade-<...>.tar.gz` the gate sets the provider up only through
`install-provider.sh` and that archive, as a real provider would.

The gates find MeshLLM through `--mesh`, `$PAY_ARKADE_MESH` or `mesh-llm` on the path, and the
model through `--model` or `$PAY_ARKADE_MODEL`. Two more gates run on the same stack. `gate/run_gateway.py` adds a member node: a non-member is
refused with its node id, a member's requests are paid from the hive's job up to its allowance and
then refused, the provider still refuses the member directly, and the usage logged per member adds
up to the latest receipt. `gate/run_hardening.py` covers streams (refused without usage, paid with
it), four requests at once on one job, and the provider's and then the agent's node restarting in the
middle of a job. Setting `PAY_ARKADE_TRACE=1` logs every hook call.

MeshLLM 0.79 occasionally fails a burst of concurrent requests on the provider with a 503 before
any token is generated. Nothing is billed for those, and clients retry them; the hardening gate
retries the same way and checks that each answer is billed once.

Off regtest, the gate plays every part but the keepers. Given `--network bitcoin --operator
https://arkade.computer --emulator <url> --treasury-address <tark...> --payout-address <tark...>`
plus longer `--period` and `--margin`, it writes each funding request to `gate/out/FUND.txt` and
waits for a person to send exactly that amount to that address in one payment.

`worker/test/delegation.e2e.test.ts` needs the stack's delegate profile (`--profile delegate`,
`DELEGATE_URL`, default `http://localhost:7012`): the provider and the agent sign an escrow's
renewal together, the delegate service renews it into the same address with a later expiry, and the
provider claims the renewed escrow. `gate/run_gate.py --delegate <url>` runs the phase 2 gate with it.

`worker/test/renewal.e2e.test.ts` needs an executord beside the stack (`EXECUTOR_URL`, default
`http://localhost:7090`): it registers a job's renewal, funds the escrow, waits for the executor to
renew it into the same address with a later expiry, then claims the renewed escrow with a receipt.
`gate/run_gate.py --executor <url>` runs the whole phase 2 gate with renewal in place of long-lived
coins.

Recompile the contract after a change with `arkadec` from `arkade-os/compiler`:

```bash
arkadec contracts/job_escrow.ark -o contracts/job_escrow.artifact.json
```
