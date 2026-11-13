# The live test: a new hive, from setup to a paid job

This is the run that shows a community can set up a hive in Buzz and pay for AI work with it, with
no step done on anyone's behalf. A fresh community gets a hive through HiveBot, its three keepers
make their keys on their own devices, members chip in and approve a proposal, a member uses the
model, two keepers sign the payment in their consoles, the provider is paid for exactly what was
served, and the rest comes back to the treasury.

The same run has been rehearsed end to end on a local regtest stack: `test/rehearsal-service.ts`
runs two hives on one shared service, one with the agent node the service runs and one with the
community's own node linked to it, and drives the keepers' consoles in a real browser with passkeys,
the hives' desks, the delegatee and the MeshLLM nodes, checking where every sat lands. The live test
adds what a rehearsal cannot show: people, their own devices, Buzz itself and mainnet.

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

## The host

One shared Hive service carries every hive of the pilot, as decided on November 13: the hives'
channels, their signing desks and their agent nodes run on Alex's server, beside the delegatee and
its Postgres database, while the keeper console is served from an origin of its own so that no
other page can reach a keeper's unlocked key. A community may still bring its own MeshLLM node as
its agent. `deploy/setup.sh` sets the whole host up on Debian 12 or Ubuntu 24.04:

```bash
sudo deploy/setup.sh          # writes /etc/hive/hive.env and stops
sudo $EDITOR /etc/hive/hive.env
sudo deploy/setup.sh          # installs, builds and starts everything
```

The environment file names the service's host and the console's, the mainnet Emulator, the
delegatee's admin users and the age key backups are encrypted to. The second run installs Node, Go,
Postgres and Caddy, builds the delegatee at its pinned commit and the console for real funds, puts
both host names behind TLS, starts the delegatee, the service and a backup timer, and writes the
delegate key the delegatee names into the environment file. It prints the console's SHA-256 hashes:
the build is the same byte for byte from the same commit, so a keeper can build it and compare.
Mainnet stays off until Alex uncomments `BUZZ_MAINNET=enabled` in the file and restarts the
service.

The delegate key is part of every treasury address the delegatee renews, so a host that loses it
can no longer renew those coins, and they have to leave through the keepers. The backup timer runs
`tools/backup.sh` every six hours, and setup runs it once before any coin arrives: it puts the
delegate key, the delegatee's database and the service's state into one archive encrypted to the age
key, refuses to write one that holds no delegate key, and keeps thirty days in `.local/backups`.
Copy that directory off the server; the script's header shows how to restore on a fresh host.

## Who takes part

- **The founder**, who creates the community and its hive channel, installs the plugin and adds
  HiveBot.
- **Three keepers**, each with their own device and a passkey (Touch ID, Face ID or a phone).
- **One or two members**, who chip in, propose and use the model. One runs a MeshLLM member node.
- **A provider**, running MeshLLM with the pay-arkade plugin and a model.
- **Alex**, who runs the shared service, approves the hive when HiveBot asks for it, and turns
  mainnet on for the run.

## Settings for a quick run

The run keeps every rule a real hive has, with shorter waits where a rule allows it:

- `HIVE_DISCUSSION_MINUTES=10` in the host's environment: proposals are discussed for ten minutes
  instead of a day or two. The plugin takes the same length from the service.
- The agents' `--cap-sats 20000` keeps each job well under the escrow ceiling, and
  `--period-secs 172800` gives each job two days, so the keepers have the best part of a day to
  sign: a keeper payment stays valid for at most 23 hours, the most the delegatee accepts.
- Both MeshLLM sides take `--delegate https://delegate.arkade.money` (on the host, through
  `--agent-arg` in `HIVE_AGENTS`), so the escrows renew through the Arkade wallet's delegate, which
  the buyer and the provider sign for, and any treasury coin can fund them. The treasury itself
  renews through the host's delegatee.

## The run

### 1. The plugin and HiveBot

One plugin serves every hive on the service, and finds its own by the channel it sits in. Build it
once and publish it on the `plugin` branch:

```bash
node hive/hive-buzz/plugin/build.mjs --service https://<service host> --name "Hive" \
  --install https://github.com/brg444/hive#plugin --console https://<console host>/
```

The founder creates the community and a channel for the hive in Buzz, installs the plugin with
Settings → Plugins → Add from Git, creates a Hive bot on the Agents page and adds it to the channel,
then mentions it with "set up with 3 keepers". HiveBot asks the service for a hive for this channel,
and the hive waits for Alex's approval:

```bash
cd /opt/hive && sudo -u hive pnpm ops service-list --network bitcoin
sudo -u hive pnpm ops service-approve <hive> --network bitcoin
```

HiveBot asks for keepers; three people react ✅, and the founder confirms them.

**Passes when** the hive is listed as approved, and HiveBot posts the plugin and key instructions,
naming the three keepers.

### 2. The keepers' keys

Each keeper opens the keeper console at `https://<console host>/` on their own device, creates their
key with their passkey, saves the encrypted backup to iCloud Drive or Google Drive with the
passphrase kept elsewhere, and posts the line it gives them in the channel. A keeper who wants to
check the console first builds it from the same commit with `node hive/hive-buzz/keeper/build.mjs
<dir> --mainnet` and compares the `SHA256SUMS` it writes with the host's
`https://<console host>/SHA256SUMS`.

**Passes when** HiveBot acknowledges each key and says all three are in.

### 3. The treasury and the agent

Members' plugins forward the channel to the service, which reads the keepers HiveBot recorded and
the keys they posted. Once the third key is in, it builds the treasury from the three keys in the
order HiveBot confirmed the keepers, keeping none of them, registers the treasury's renewal with the
delegatee, and starts the hive's agent node.

A community that runs its own agent instead sets up a MeshLLM node with the pay-arkade plugin as
buyer, with `--treasury-program` set to the program the hive's page shows, and a keeper names it in
the channel with `Hive agent: <the buyer's key>`. The service then stops its own node for the hive,
and the community's node links to it:

```bash
pay-arkade-worker --key-file <the buyer's key> --hive-link https://<service host>/c/<channel ID> \
  --log <the buyer's --log> --members-file <the buyer's --members-file>
```

**Passes when** HiveBot posts the treasury's address in the channel, the plugin shows it, and the
hive's page names its agent.

### 4. The signing desk

Every hive has its signing desk on the service, under `https://<service host>/c/<channel ID>`, the
address the console asks for, and the plugin's Keepers tab links each keeper to the console with it
filled in. Each keeper opens it once and unlocks it
with their passkey, which shares the nonces their later signatures need and pins the treasury's
address in that browser. The hive's listing, for discovery on Nostr, is written on the host and
signed by the keepers at the same desk:

```bash
sudo -u hive pnpm ops listing <hive> --name "<hive name>" --purpose "<what the hive is for>"
```

**Passes when** each keeper has opened the desk once, and the desk has no listing left waiting
(`GET …/desk/v1/listing`).

### 5. Chip-ins and the first proposal

Members send to the treasury's address from any Arkade wallet. A member presses Propose in the
channel and posts the proposal; others react 👍. After the ten-minute discussion, two keepers react
✅. The member who will use the model sets up their node with the agent's node ID, which the hive's
page shows, joins the hive's mesh with the invite at `https://<service host>/c/<channel ID>/hive/v1/invite`,
and posts the node's ID in the channel:

```bash
packaging/install-member.sh --archive pay-arkade-<version>-<os>-<arch>.tar.gz --agent <agent node id>
# then in the channel: Hive node: <the member's node id>
```

**Passes when** the plugin shows the chip-ins and the proposal as running, and the member's node is
among the members the agent serves, with the proposal's allowance.

### 6. The provider and the first job

The provider installs with `packaging/install-provider.sh` and joins the hive's mesh with the same
invite. The agent on the host pays only providers it is told to, through
`--agent-arg --allow-peer --agent-arg <provider node id>` in `HIVE_AGENTS`; a community's own agent
takes `--allow-peer` directly.

The member asks the `hive` model on their own node. The first request opens a job: the agent gets a
quote and asks the keepers to fund it.

**Passes when** the plugin's Keepers tab shows the job waiting, with a link to the console.

### 7. Two keepers sign

The first keeper opens the console, checks the job (the escrow is rebuilt from the job's terms and
gives back to this treasury; the amount fits what approved work has left) and signs. The second keeper
does the same later, signing both remaining steps. The first keeper comes back once to finish. The
desk then hands the payment to the delegatee.

**Passes when** the escrow holds exactly the cap, the job opens on both nodes, and a third keeper
cannot fund the same job again.

### 8. The work, the claim and the return

The member uses the model. The provider claims the latest receipt before the deadline, and the rest
goes back to the treasury.

**Passes when** the provider's payout equals what was metered, the treasury holds what came back,
and the plugin and the hive's page account for every sat.

## Failure checks in the same run

- A keeper cancels a payment halfway, and another pair signs it instead.
- A job runs to its deadline unused, and returns whole to the treasury.
- Someone who is not a keeper posts a key line, and HiveBot says it does not count.
- A forged or edited channel event forwarded to the service is refused.
- A keeper opens the desk from a second browser, which holds none of the nonces they shared from the
  first: a payment paired with them there cannot be finished, so the other keeper cancels it and
  starts it again, and the desk pairs them with nonces the new browser shared.

## Rehearsal on regtest

```bash
PAY_ARKADE_MESH=<mesh-llm> PAY_ARKADE_MODEL=<model.gguf> PAY_ARKADE_DIR=<pay-arkade checkout> \
  node --experimental-eventsource --import tsx test/rehearsal-service.ts
```

It needs a regtest stack whose Operator states its delays in seconds (an exit delay of 512 or more),
the delegatee from `tools/delegatee.sh`, MeshLLM 0.79 with a small model, pay-arkade built, and
Playwright's Chromium. It writes each step and the outcome to
`.local/rehearsal/service-<run>/result.json`. `test/rehearsal.ts` runs one hive on a host of its
own, with hive-api and `pnpm ops desk`, and `test/keeper-console-e2e.ts` runs the keepers' part
alone, against the in-memory network.
