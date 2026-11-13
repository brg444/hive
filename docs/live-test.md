# The live test: a new hive, from setup to a paid job

This is the run that shows a community can set up a hive in Buzz and pay for AI work with it, with
no step done on anyone's behalf. A fresh community gets a hive through HiveBot, its three keepers
make their keys on their own devices, members chip in and approve a proposal, a member uses the
model, two keepers sign the payment in their consoles, the provider is paid for exactly what was
served, and the rest comes back to the treasury.

The same run has been rehearsed end to end on a local regtest stack: `test/rehearsal.ts` drives the
keepers' consoles in a real browser with passkeys, the signing desk, the delegatee, three MeshLLM
nodes and hive-api, and checks where every sat lands. The live test adds what a rehearsal cannot
show: people, their own devices, Buzz itself and mainnet.

## Mainnet, and the delegatee the server runs

Decided on November 13, 2026: the live test runs on mainnet, and the hive's own server runs the
delegatee. The Arkade wallet's delegate service only submits renewals a coin's owner has already
signed, while a v4 treasury needs a delegatee that renews it unattended and carries out the keepers'
signed payments, which is what arkade-os/delegatee does.

Mainnet stays behind an opt-in: every command that touches it needs `BUZZ_MAINNET=enabled`, set on
the hive's server for the run and unset afterwards. The hard ceilings stay in force: 50,000 sats per
escrow, 100,000 per chip-in, 1,000,000 in the treasury. The tools build only a keepers' hive there,
and refuse to make or keep a key for real funds.

Start the delegatee on the server, beside a Postgres database:

```bash
DELEGATEE_NETWORK=bitcoin DELEGATEE_DATABASE_URL='postgres://…/delegatee' \
DELEGATEE_EMULATOR_URL=<the mainnet Emulator> DELEGATEE_ADMIN_AUTH=file \
DELEGATEE_ADMIN_USERS_FILE=<admin users> tools/delegatee.sh
```

It talks to the Operator at arkade.computer, keeps its delegate key in
`.secrets/bitcoin/delegate-key`, and names that key as `delegatePubkey` in its `/v1/info`. Put it
behind the server's TLS proxy, then point the hive's tools at it:

```bash
export BUZZ_MAINNET=enabled BUZZ_DELEGATEE_URL=https://<host>/delegatee
export BUZZ_DELEGATE_KEY=<delegatePubkey from its /v1/info>
```

The Operator's key and exit delay and the Emulator's key are pinned in
`packages/ark/src/deployment.ts`, so a delegatee that served another Operator or Emulator is
refused. The Emulator's address stays in the server's environment, out of the repository. Mutinynet
is skipped, as decided on November 11.

## Who takes part

- **The founder**, who creates the community and its hive channel, installs the plugin and adds
  HiveBot.
- **Three keepers**, each with their own device and a passkey (Touch ID, Face ID or a phone).
- **One or two members**, who chip in, propose and use the model. One runs a MeshLLM member node.
- **A provider**, running MeshLLM with the pay-arkade plugin and a model.
- **The hive's host**, a server with TLS that runs the hive's agent node, hive-api, the signing desk,
  the delegatee and the keeper console.

## Settings for a quick run

The run keeps every rule a real hive has, with shorter waits where a rule allows it:

- hive-api's `--discussion-minutes 10`: proposals are discussed for ten minutes instead of a day or
  two. The plugin takes the same length from the host.
- The agent's `--cap-sats 20000` keeps each job well under the escrow ceiling, and
  `--period-secs 172800` gives each job two days, so the keepers have the best part of a day to
  sign: a keeper payment stays valid for at most 23 hours, the most the delegatee accepts.
- Both MeshLLM sides take `--delegate https://delegate.arkade.money`, so escrows renew and any
  treasury coin can fund them.

## The run

### 1. The community and the host

Create the community and a channel for the hive in Buzz, and copy the channel's ID. On the host,
start hive-api before anything else, with no treasury yet: it collects the channel as members' plugins
forward it.

```bash
node hive/hive-buzz/api/src/server.mjs --name "<hive name>" --agent-log <agent log> \
  --operator https://arkade.computer --channel <channel ID> --bot <HiveBot's public key> \
  --governance <host>/governance.json --members-file <host>/members.json --model <model id> \
  --discussion-minutes 10 --desk https://<host>/desk --console https://<host>/keeper/ --port 8787
```

The agent log can be an empty file until the agent runs. hive-api learns the keepers from HiveBot's
own record in the channel, so `--bot` takes HiveBot's public key, from its profile in Buzz.

### 2. The plugin and HiveBot

Build the plugin for this hive and publish it on the `plugin` branch, then install it in Buzz with
Settings → Plugins → Add from Git:

```bash
node hive/hive-buzz/plugin/build.mjs --api https://<host> --name "<hive name>" \
  --install https://github.com/brg444/hive#plugin --console https://<host>/keeper/
```

On the Agents page, create a Hive bot and add it to the hive's channel. Mention it with "set up
with 3 keepers". HiveBot asks for keepers; three people react ✅, and the founder confirms them.

**Passes when** HiveBot posts the plugin and key instructions, naming the three keepers.

### 3. The keepers' keys

Each keeper opens the keeper console on their own device, creates their key with their passkey,
saves the encrypted backup to iCloud Drive or Google Drive with the passphrase kept elsewhere, and
posts the line it gives them in the channel. Build the console for real funds and serve it from the
host:

```bash
node hive/hive-buzz/keeper/build.mjs <host>/keeper --mainnet
```

**Passes when** HiveBot acknowledges each key and says all three are in.

### 4. The treasury

hive-api's governance lists the keepers' treasury keys in the order HiveBot confirmed the keepers,
which is the order the treasury is built in. Build it, then restart hive-api with the treasury:

```bash
BUZZ_MAINNET=enabled pnpm ops init <hive> --network bitcoin --keepers <key 1>,<key 2>,<key 3>
# then add to hive-api: --treasury <treasuryAddress>
```

`ops init` keeps no keeper key: it prints the treasury's address and program and registers the
treasury's renewal with the delegatee. Write the hive's listing for the keepers to sign:

```bash
pnpm ops listing <hive> --name "<hive name>" --purpose "<what the hive is for>"
```

**Passes when** HiveBot posts the treasury's address in the channel, and the plugin shows it.

### 5. The signing desk

```bash
BUZZ_MAINNET=enabled pnpm ops desk <hive> --agent-log <agent log> --governance <host>/governance.json \
  --port 8790 --origin https://<host>
```

Put it behind the host's TLS proxy at `https://<host>/desk`. Each keeper opens the console with
`?desk=https://<host>/desk`, unlocks it with their passkey and signs the listing. Opening the desk
also shares the nonces a keeper's later signatures need.

**Passes when** the desk has no listing left waiting (`GET /desk/v1/listing`), and each keeper
has opened the desk once.

### 6. Chip-ins and the first proposal

Members send to the treasury's address from any Arkade wallet. A member presses Propose in the
channel and posts the proposal; others react 👍. After the ten-minute discussion, two keepers react
✅. The member who will use the model sets up their node and posts its ID in the channel:

```bash
packaging/install-member.sh --archive pay-arkade-<version>-<os>-<arch>.tar.gz --agent <agent node id>
# then in the channel: Hive node: <the member's node id>
```

**Passes when** the plugin shows the chip-ins and the proposal as running, and hive-api's members
file names the member's node with the proposal's allowance.

### 7. The agent, the provider and the first job

The provider installs with `packaging/install-provider.sh` and joins the hive's mesh. The agent runs
on the host as the buyer, paying into escrows that return to the treasury:

```bash
--role buyer --treasury-program <treasuryProgram> --funding-queue <queue> --log <agent log> \
--members-file <host>/members.json --cap-sats 20000 --period-secs 172800 \
--delegate https://delegate.arkade.money --allow-peer <provider node id>
```

The member asks the `hive` model on their own node. The first request opens a job: the agent gets a
quote and asks the keepers to fund it.

**Passes when** the plugin's Keepers tab shows the job waiting, with a link to the console.

### 8. Two keepers sign

The first keeper opens the console, checks the job (the escrow is rebuilt from the job's terms and
gives back to this treasury; the amount fits what approved work has left) and signs. The second keeper
does the same later, signing both remaining steps. The first keeper comes back once to finish. The
desk then hands the payment to the delegatee.

**Passes when** the escrow holds exactly the cap, the job opens on both nodes, and a third keeper
cannot fund the same job again.

### 9. The work, the claim and the return

The member uses the model. The provider claims the latest receipt before the deadline, and the rest
goes back to the treasury.

**Passes when** the provider's payout equals what was metered, the treasury holds what came back,
and the plugin and the hive's page account for every sat.

## Failure checks in the same run

- A keeper cancels a payment halfway, and another pair signs it instead.
- A job runs to its deadline unused, and returns whole to the treasury.
- Someone who is not a keeper posts a key line, and HiveBot says it does not count.
- A forged or edited channel event forwarded to hive-api is refused.

## Rehearsal on regtest

```bash
PAY_ARKADE_MESH=<mesh-llm> PAY_ARKADE_MODEL=<model.gguf> PAY_ARKADE_DIR=<pay-arkade checkout> \
  node --import tsx test/rehearsal.ts
```

It needs a regtest stack whose Operator states its delays in seconds (an exit delay of 512 or more),
the delegatee from `tools/delegatee.sh`, MeshLLM 0.79 with a small model, pay-arkade built, and
Playwright's Chromium. It writes each step and the outcome to `.local/rehearsal/<run>/result.json`.
`test/keeper-console-e2e.ts` runs the keepers' part alone, against the in-memory network.
