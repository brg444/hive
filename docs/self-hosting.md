# Running Hive for a Buzz community

This guide takes a Buzz community from nothing to a paid job: a hive set up through HiveBot, three
keepers who make their keys on their own devices, members who chip in and approve a proposal, a
member who uses a model through MeshLLM, two keepers who sign the payment, and a provider paid for
exactly what it served, with the rest back in the treasury. Everything here is self-hosted. Nobody
runs a Hive service for you, so whoever sets a hive up also runs its host, or joins a host someone
else in the community runs.

The whole flow has been rehearsed end to end on a local regtest stack (see
[Trying it locally first](#trying-it-locally-first)). It has not been run end to end on mainnet, so
treat a first run there as the experiment it is, with small amounts.

## What runs where

A hive has three kinds of moving parts, and only the first needs a server:

- **The host** runs the Hive service, which keeps every hive it carries under its Buzz channel, with
  its signing desk and, if the community wants it, its agent node. Beside it run the delegatee, which
  renews the treasury's coins and carries out the keepers' signed payments, its Postgres database,
  and the keeper console, served from an address of its own.
- **The community** runs Buzz as it already does: the Hive plugin in members' apps, and HiveBot, an
  agent the plugin defines, which runs in the community owner's Buzz app.
- **The MeshLLM nodes**: the hive's agent node, which buys inference with the treasury's money and
  serves it to members; the provider's node, which serves a model and is paid per token; and each
  member's node, through which a member asks the `hive` model. The agent node runs either on the host,
  started by the service, or wherever the community likes, linked to the service.

The keepers' keys never reach any of these: each keeper makes and keeps theirs in the keeper console,
on their own device, behind a passkey.

## The host

`deploy/setup.sh` sets the host up on Debian 12 or Ubuntu 24.04: Node, Go, Postgres and Caddy, the
service, the delegatee built at its pinned commit, the keeper console, TLS for two host names, and a
backup timer. Run it as root from a checkout of your fork:

```bash
sudo deploy/setup.sh          # writes /etc/hive/hive.env and stops
sudo $EDITOR /etc/hive/hive.env
sudo deploy/setup.sh          # installs, builds and starts everything
```

`deploy/hive.env.example` explains every setting. You choose the two host names, one for the
service and one for the console, and point both at the server before the second run so Caddy can
obtain certificates. The console gets an origin of its own so that no other page can reach a
keeper's unlocked key. On mainnet the delegatee also needs the mainnet Emulator's address, which Ark
Labs gives out, and a file of admin users for its admin port. The second run prints the console's
SHA-256 hashes: the build is the same byte for byte from the same commit, so a keeper can build the
console themselves and compare.

Members who read amounts in US dollars need the Bitcoin price, which the service reads from
mempool.space every five minutes and passes on with each hive's state; nothing the hive signs or pays
depends on it. `HIVE_PRICE_URL` in `hive.env` names another source answering `{ "USD": <price> }`, and
`HIVE_PRICE_URL=off` stops the service from asking.

Mainnet stays off until you uncomment `BUZZ_MAINNET=enabled` in `hive.env` and restart the service.
The Operator's key and exit delay and the Emulator's key are pinned in
`packages/ark/src/deployment.ts`, so a delegatee that served another Operator or Emulator is refused,
and hard ceilings apply: 50,000 sats per escrow, 100,000 per chip-in and 1,000,000 in a treasury.

### Backups

The delegatee's delegate key is part of every treasury address it renews, so a host that loses it
can no longer renew those coins, and they have to leave through the keepers. The backup timer runs
`tools/backup.sh` every six hours, and setup runs it once before any coin arrives. It puts the
delegate key, the delegatee's database and the service's state into one archive encrypted to an age
key whose secret half you keep off the server, refuses to write one that holds no delegate key, and
keeps thirty days in `.local/backups`. Copy that directory off the server as well; the script's header
shows how to restore on a fresh host.

## The MeshLLM nodes

All three kinds of node run MeshLLM with the pay-arkade plugin; [its README](../hive/pay-arkade/README.md)
covers the plugin's flags, packaging and the installers.

**The agent on the host.** With `HIVE_AGENTS` set in `hive.env`, the service starts a buyer node for
each hive once its treasury is built, and restarts it if it stops. The setting names the MeshLLM
binary, the plugin and its worker, the model, the cap and length of each job, and any buyer flag to
pass on with `--agent-arg`, such as `--network bitcoin`, the escrows' delegate service and the
providers the agent may pay (`--allow-peer <node id>`). Its mesh invite is served at
`https://<service host>/c/<channel ID>/hive/v1/invite`, for providers and members to join.

**The community's own agent.** A community that would rather run its agent itself sets up a MeshLLM
node with the plugin as buyer, its `--treasury-program` set to the program the hive's page shows.
A keeper names it in the channel with `Hive agent: <the buyer's key>`, the key its worker's `ping`
answers. The service then stops its own node for that hive, and the community's node reports to it:

```bash
pay-arkade-worker --key-file <the buyer's key> --hive-link https://<service host>/c/<channel ID> \
  --log <the buyer's --log> --members-file <the buyer's --members-file>
```

Every fifteen seconds the link sends what the buyer logged since the last time, so the hive's page,
its desk and the members' usage follow the jobs, and brings the members file back.

**The provider and the members.** A provider installs with `packaging/install-provider.sh` and a
member with `packaging/install-member.sh --agent <the agent's node ID>`; both join the hive's mesh with
the agent's invite. The hive's page shows the agent's node ID.

## The plugin

One plugin serves every hive on a service, and finds its own by the channel it sits in. Build it
once for your service and publish it where members install it from, such as a `plugin` branch of
your fork:

```bash
node hive/hive-buzz/plugin/build.mjs --service https://<service host> --name "Hive" \
  --install https://github.com/<you>/hive#plugin --console https://<console host>/
```

A hive that wants a host of its own, without the service, can run hive-api and `pnpm ops desk`
instead and build its plugin with `--api`; [the Buzz plugin's README](../hive/hive-buzz/README.md)
describes that setup.

## A hive from setup to a paid job

The steps below follow one hive. For a first run, a shorter discussion helps:
`HIVE_DISCUSSION_MINUTES=10` in `hive.env` gives every proposal ten minutes instead of a day or two,
and the plugin takes the same length from the service. A job's two-day period leaves the keepers the
best part of a day to sign, since a keeper payment stays valid for at most 23 hours, the most the
delegatee accepts.

### 1. The community asks for a hive

The founder creates the community and a channel for the hive in Buzz, installs the plugin with
Settings → Plugins → Add from Git, creates a Hive bot on the Agents page and adds it to the channel,
then mentions it with "set up with 3 keepers". HiveBot asks the service for a hive for this channel,
proving it with its first message there, and the hive waits until the host's operator opens it:

```bash
cd /opt/hive && sudo -u hive pnpm ops service-list --network bitcoin
sudo -u hive pnpm ops service-approve <hive> --network bitcoin
```

HiveBot then asks for keepers; three people react ✅, and the founder confirms them.

### 2. The keepers' keys

Each keeper opens the keeper console at `https://<console host>/` on their own device, creates their
key with their passkey, saves the encrypted backup to iCloud Drive or Google Drive with the
passphrase kept elsewhere, and posts the line the console gives them in the channel. HiveBot
acknowledges each key and says when all three are in.

### 3. The treasury and the agent

Members' plugins forward the channel to the service, which checks every event's signature and reads
the keepers HiveBot recorded and the keys they posted. Once the third key is in, it builds the
treasury from the three keys, in the order HiveBot confirmed the keepers, keeps none of them,
registers the treasury's renewal with the delegatee, and starts the hive's agent node unless a keeper
names the community's own. HiveBot posts the treasury's address, and the plugin shows it.

### 4. The signing desk

Every hive has its signing desk on the service, under `https://<service host>/c/<channel ID>`, the
address the console asks for, and the plugin's Keepers tab links each keeper to the console with it
filled in. Each keeper opens it once and unlocks it with their passkey, which shares the nonces their
later signatures need and pins the treasury's address in that browser. A keeper who opens the desk
later from another browser has none of the nonces the first one shared, so a payment paired with them
there is cancelled by the other keeper and started again.

The hive's listing, for discovery on Nostr, is written on the host and signed by the keepers at the
same desk:

```bash
sudo -u hive pnpm ops listing <hive> --name "<hive name>" --purpose "<what the hive is for>"
```

### 5. Chip-ins and the first proposal

Members send to the treasury's address from any Arkade wallet. A hive on the service has no
Lightning address yet; a hive on a host of its own gets one from `pnpm ops init --lnurl`, which any
Lightning wallet can pay. A member presses Propose in the
channel and posts the proposal, others react 👍, and once the discussion closes two keepers react ✅.
The member who will use the model sets up their node, joins the hive's mesh and posts the node's ID
in the channel as `Hive node: <node ID>`. Once HiveBot acknowledges it, the agent serves that node up
to the proposal's allowance.

### 6. The provider and the first job

The provider joins the hive's mesh, and the agent's `--allow-peer` names it. The member asks the
`hive` model on their own node; the first request opens a job, for which the agent gets a quote and
asks the keepers to fund it. The plugin's Keepers tab shows the job waiting, with a link to the
console.

### 7. Two keepers sign

The first keeper opens the console, checks the job (the escrow is rebuilt from the job's terms and
gives back to this treasury, and the amount fits what approved work has left) and signs. The second
keeper does the same later, signing both remaining steps, and the first comes back once to finish.
The desk then hands the payment to the delegatee, and the escrow holds exactly the job's cap.

### 8. The work, the claim and the return

The member uses the model. The provider claims the latest receipt before the deadline, and the rest
goes back to the treasury. A job nobody claims returns whole once its deadline passes, with nobody
signing.

## Trying it locally first

`test/rehearsal-service.ts` runs all of the above on a local regtest stack: two hives on one service,
one with the agent node the service runs and one with a community's own node linked to it, with the
keepers' consoles in a real browser with virtual passkeys, the hives' desks, the delegatee and four
MeshLLM nodes. It checks where every sat lands.

```bash
PAY_ARKADE_MESH=<mesh-llm> PAY_ARKADE_MODEL=<model.gguf> PAY_ARKADE_DIR=<pay-arkade checkout> \
  node --experimental-eventsource --import tsx test/rehearsal-service.ts
```

It needs a regtest stack whose Operator states its delays in seconds (an exit delay of 512 or more),
the delegatee from `tools/delegatee.sh`, MeshLLM 0.79 with a small GGUF model, pay-arkade built, and
Playwright's Chromium; [Running Hive](running.md) lists the stack. Each run writes its steps and
outcome to `.local/rehearsal/service-<run>/result.json`. `test/rehearsal.ts` does the same for one
hive on a host of its own, and `test/keeper-console-e2e.ts` runs the keepers' part alone against the
in-memory network.
