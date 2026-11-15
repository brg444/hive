# Running Hive for a Buzz community

This guide takes a Buzz community from nothing to a paid job: a hive set up through HiveBot, three
keepers whose Buzz accounts hold the treasury, members who chip in and approve a proposal, a member
who uses a model through MeshLLM, two keepers who approve the payment in the channel, and a provider paid for
exactly what it served, with the rest back in the treasury. Everything here is self-hosted. Nobody
runs a Hive service for you, so whoever sets a hive up also runs its host, or joins a host someone
else in the community runs.

The whole flow has been rehearsed end to end on a local regtest stack (see
[Trying it locally first](#trying-it-locally-first)); since keepers began approving from Buzz, the
treasury, the desk and the plugin have run end to end there, and the full rehearsal with MeshLLM
nodes has not been run again. It has not been run end to end on mainnet, so treat a first run there
as the experiment it is, with small amounts.

## What runs where

A hive has three kinds of moving parts, and only the first needs a server:

- **The host** runs the Hive service, which keeps every hive it carries under its Buzz channel, with
  its approvals desk and, if the community wants it, its agent node. Beside it run the delegatee,
  which renews the treasury's coins, and its Postgres database.
- **The community** runs Buzz as it already does: the Hive plugin in members' apps, and HiveBot, an
  agent the plugin defines, which runs in the community owner's Buzz app.
- **The MeshLLM nodes**: the hive's agent node, which buys inference with the treasury's money and
  serves it to members; the provider's node, which serves a model and is paid per token; and each
  member's node, through which a member asks the `hive` model. The agent node runs either on the host,
  started by the service, or wherever the community likes, linked to the service.

The keepers' keys never reach any of these: a keeper's key is their Buzz account's own, which Buzz
keeps on their device and signs their messages with. The README explains [how the treasury is built
from those keys](../README.md#from-a-buzz-identity-to-the-treasury).

## The host

`deploy/setup.sh` sets the host up on Debian 12 or Ubuntu 24.04: Node, Go, Postgres and Caddy, the
service, the delegatee built at its pinned commit, TLS for the service's host name, a backup timer and a check that runs every five minutes. Run it as root from a checkout of your fork:

```bash
sudo deploy/setup.sh          # writes /etc/hive/hive.env and stops
sudo $EDITOR /etc/hive/hive.env
sudo deploy/setup.sh          # installs, builds and starts everything
```

`deploy/hive.env.example` explains every setting. You choose the service's host name and point it
at the server before the second run so Caddy can obtain its certificate. On mainnet the delegatee
also needs the mainnet Emulator's address, which Ark Labs gives out, and a file of admin users for
its admin port.

Members who read amounts in US dollars need the Bitcoin price, which the service reads from
mempool.space every five minutes and passes on with each hive's state; nothing the hive signs or pays
depends on it. `HIVE_PRICE_URL` in `hive.env` names another source answering `{ "USD": <price> }`, and
`HIVE_PRICE_URL=off` stops the service from asking.

Two users run the host, so that what faces the network holds as little as it can. `hive` runs the
service and each hive's agent node, and keeps the channels, the desks and the agents' receipt keys.
`hive-delegatee` runs the delegatee, and alone reads the delegate key and the delegatee's database.
The code in `/opt/hive` belongs to root, and neither user can change it; both services run under
systemd's sandbox, with only their own state writable. The agent nodes are the service's children
and share its user, so a hive that wants its agent apart from every other hive's runs its own
(see [The community's own agent](#the-meshllm-nodes)). Node and Go are installed only when their
downloads match the checksums their publishers list, which `setup.sh` carries for the releases it
names, and dependencies come at the versions the lockfiles name, with no install script run.

The keys on the host are files, readable by their own user only: the delegate key, each agent's
receipt key, the issuer's key, and nothing that moves a treasury. A file whose mode lets other users read it is
refused. To keep them encrypted at rest as well, put the host on an encrypted disk, or hand the
delegate key to the delegatee through systemd's encrypted credentials.

Each hive's treasury is named by its counter, an asset the host issues for it from the issuer, a
small wallet of the host's own whose key the service makes once in `.secrets/issuer/<network>.json`.
The issuer sends the whole counter to the new treasury with 1,000 sats as its carrier, so it needs a
few thousand sats before the first hive: the service names its address when it runs short. It holds
only the host's own sats, never a treasury's. The treasury's payments go out through the Emulator,
whose address the service takes from `BUZZ_EMULATOR_URL` on mainnet, the same one the delegatee is
given.

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
keeps thirty days in `/var/backups/hive`. Copy that directory off the server as well: a backup on
the same disk is no backup.

To restore on a fresh host, run `deploy/setup.sh` up to its first stop, fill in `hive.env` as it was,
and before the second run put the archive's contents back:

```bash
sudo systemctl stop hive-service hive-delegatee 2>/dev/null
age -d -i <secret key file> hive-<stamp>.tar.age | sudo tar xf - -C /opt/hive
sudo install -d -o hive-delegatee -g hive-delegatee -m 700 /var/lib/hive-delegatee
sudo mv /opt/hive/delegatee/.secrets /var/lib/hive-delegatee/.secrets && sudo rmdir /opt/hive/delegatee
sudo chown -R hive-delegatee: /var/lib/hive-delegatee/.secrets
sudo deploy/setup.sh
sudo -u hive-delegatee pg_restore --clean --if-exists -d "<DELEGATEE_DATABASE_URL>" /opt/hive/delegatee.dump
sudo rm /opt/hive/delegatee.dump && sudo systemctl restart hive-delegatee hive-service
```

The users exist after the first run of `setup.sh` on the new host, so run it once before these
commands if it has not been. Rehearse a restore before the treasury holds anything that matters.

### Watching the host

`tools/check.sh` runs every five minutes from `hive-check.timer`. It says, one line each, whether
the service and the delegatee answer, whether the delegatee still signs with the delegate key
`hive.env` names, whether there is a backup from the last thirteen hours, and whether the disk has room. Each finding
goes to the journal at error priority (`journalctl -p err -u hive-check`), and with `HIVE_ALERT_URL`
set in `hive.env` it is also posted there as plain text, to an ntfy topic or any address that takes
a POST. The services' own logs are in `journalctl -u hive-service -u hive-delegatee`.

The service turns away more than a client's share of requests: a few requests for a hive a minute
from one address, some dozens of forwarded channels, a few hundred reads. Members behind one address
share its allowance, so raise the numbers in `tools/service.ts` if a large community sits behind one.

### When the host is gone

The treasury's coins need the Operator, the Emulator and two keepers to move, and the delegatee to
renew them. If the host is lost, restore it from a backup: the keepers' keys were never on it, and
the delegate key and the delegatee's database are in the archive. Until it is back, the keepers'
approvals wait in the channel with nobody to submit them, and the treasury's coins are not renewed. A coin
that is not renewed before its batch expires is swept by the Operator, so a host that stays down for
weeks puts the treasury at risk: bring a host back, on any server, well before that. If the delegate
key is lost for good, with no backup, no host can renew the treasury again, and the keepers move its
funds out to a new treasury with a withdrawal (below) while the coins are still live.

## The MeshLLM nodes

All three kinds of node run MeshLLM with the pay-arkade plugin; [its README](../hive/pay-arkade/README.md)
covers the plugin's flags, packaging and the installers.

**The agent on the host.** With `HIVE_AGENTS` set in `hive.env`, the service starts a buyer node for
each hive once its treasury is built, and restarts it if it stops. The setting names the MeshLLM
binary, the plugin and its worker, the model, the cap and length of each job, and any buyer flag to
pass on with `--agent-arg`, such as `--network bitcoin`, the escrows' delegate service and the
providers the agent may pay (`--allow-peer <node id>`). With `HIVE_SERVE_INVITE=1` in `hive.env`
its mesh invite is served at `https://<service host>/c/<channel ID>/hive/v1/invite`, for providers
and members to join. Whoever holds an invite can join that hive's mesh, though not spend, so it is
off unless you turn it on; without it, hand the invite to providers and members yourself.

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
  --install https://github.com/<you>/hive#plugin
```

The build bundles the hive's own checking code from `packages/`, so it needs `pnpm install` at the
repository's root and `npm ci` in `hive/hive-buzz` first. It comes out the same byte for byte from
the same commit, so a keeper can build it themselves and compare it with what they installed.

A hive that wants a host of its own, without the service, can run hive-api and `pnpm ops desk`
instead and build its plugin with `--api`; [the Buzz plugin's README](../hive/hive-buzz/README.md)
describes that setup.

## A hive from setup to a paid job

The steps below follow one hive. For a first run, a shorter discussion helps:
`HIVE_DISCUSSION_MINUTES=10` in `hive.env` gives every proposal ten minutes instead of a day or two,
and the plugin takes the same length from the service. A job's two-day period leaves the keepers the
best part of a day to approve, since a payment's approvals stay valid for at most 23 hours.

### 1. The community asks for a hive

The founder creates the community and a channel for the hive in Buzz, installs the plugin with
Settings → Plugins → Add from Git, creates a Hive bot on the Agents page and adds it to the channel,
then mentions it with "set up with 3 keepers". HiveBot asks the service for a hive for this channel,
with its first message there, and the hive waits until the host's operator opens it:

```bash
cd /opt/hive && sudo -u hive pnpm ops service-list --network bitcoin
sudo -u hive pnpm ops service-approve <hive> --bot <HiveBot's npub> --network bitcoin
```

Anyone can sign a request for any channel, and the key the operator approves is the one whose
messages name the hive's keepers. So the operator names HiveBot's key with `--bot`, and takes it
from the channel itself: HiveBot's profile in Buzz shows its npub, and the founder can post it.
`service-list` shows every key that asked for the channel, and a key copied from that list proves
nothing. A request that should not be there is removed with `pnpm ops service-reject <hive>`. Until
a hive is approved the service keeps nothing of its channel and does not list it to the community's
plugins; once it is, HiveBot checks that the hive the service opened is its own, built from the
keepers in its channel, before it announces the treasury.

HiveBot then asks for keepers; three people react ✅, and the founder confirms them.

### 2. The treasury and the agent

Members' plugins forward the channel to the service, which checks every event's signature and reads
the keepers HiveBot recorded. A keeper's Buzz key is their treasury key, so there is nothing more for
them to post: the service issues the hive's counter from the issuer, builds the treasury from the
three keepers' Buzz keys in the order HiveBot confirmed them, keeps none of them, registers the
treasury's renewal with the delegatee, sends the whole counter to the treasury and checks that it
arrived, and starts the hive's agent node unless a keeper names the community's own. HiveBot posts
the treasury's address, and the plugin shows it. HiveBot also reminds each keeper to back up their
Buzz key in Settings → Identity, since it is now their share of the treasury: Buzz made that key at
random for their identity, and no seed or server can make it again.

### 3. The desk

Every hive has its approvals desk on the service. It follows the hive's channel as members' plugins
forward it, makes each job the agent asks the keepers to fund into a payment, takes in the keepers'
approvals and declines, and submits a payment once two keepers have approved it. What it has waiting
is in the hive's state, which each keeper's plugin reads. The desk also folds each chip-in and each
escrow's remainder into the treasury coin as they arrive.

### 4. Chip-ins and the first proposal

Members send to the treasury's address from any Arkade wallet. A hive on the service has no
Lightning address yet; a hive on a host of its own gets one from `pnpm ops init --lnurl`, which any
Lightning wallet can pay. A member presses Propose in the
channel and posts the proposal, others react 👍, and once the discussion closes two keepers react ✅.
The member who will use the model sets up their node, joins the hive's mesh and posts the node's ID
in the channel as `Hive node: <node ID>`. Once HiveBot acknowledges it, the agent serves that node up
to the proposal's allowance.

### 5. The provider and the first job

The provider joins the hive's mesh, and the agent's `--allow-peer` names it. The member asks the
`hive` model on their own node; the first request opens a job, for which the agent gets a quote and
asks the keepers to fund it. HiveBot tells the keepers, and each keeper's plugin shows the payment
above the message box in the hive's channel and on the Keepers tab.

### 6. Two keepers approve

Before it offers anything, a keeper's plugin checks the payment itself: it rebuilds the job's escrow
from the job's terms and checks that it gives back to this treasury and that the amount is the job's
cap, and it rebuilds the exact message the treasury's covenant will check. What approved work has
left is the desk's count, which the plugin cannot check against the channel, so a keeper looks at
the proposal there before approving. The keeper presses Approve, and the plugin writes
`I approve Hive payment <code>` into the message box; the keeper sends it as it is, since the
covenant checks every character, and the channel draws it as a card naming the payment. A second
keeper does the same, at any time before the approvals lapse, ten minutes before the job's deadline
at the latest. The desk then submits the payment through the Emulator, and the escrow holds exactly
the job's cap. A keeper who presses Decline sends `I decline Hive payment <code>`, which stops the
payment. Payments go out in the order they started; one declined or lapsed passes its number to the
next, whose keepers approve it again.

### 7. The work, the claim and the return

The member uses the model. The provider claims the latest receipt before the deadline, and the rest
goes back to the treasury. A job nobody claims returns whole once its deadline passes, with nobody
signing.

### 8. Withdrawing from the treasury

Two keepers can send the treasury's Bitcoin to an Arkade address: to move the hive to a new
treasury or a new host, or to wind it down. They agree on the address and the amount in the hive's
channel. One presses Withdraw above the message box and enters both, which writes
`Hive withdrawal: <amount> sats to <address>` for them to send; the desk makes it a payment, and two
keepers' plugins work out what the address pays themselves and offer the approval. A withdrawal's
approvals lapse after 23 hours, and the address must be on the hive's Operator. Nothing in the
plugin judges the destination. That is the keepers' own decision, which is why it takes two of them.

## Trying it locally first

`test/rehearsal-service.ts` runs all of the above on a local regtest stack: two hives on one service,
one with the agent node the service runs and one with a community's own node linked to it, with the
keepers approving through the Hive plugin itself, the hives' desks, the delegatee and four MeshLLM
nodes. It checks where every sat lands.

```bash
PAY_ARKADE_MESH=<mesh-llm> PAY_ARKADE_MODEL=<model.gguf> PAY_ARKADE_DIR=<pay-arkade checkout> \
  node --experimental-eventsource --import tsx test/rehearsal-service.ts
```

It needs a regtest stack whose Operator states its delays in seconds (an exit delay of 512 or more),
the delegatee from `tools/delegatee.sh`, MeshLLM 0.79 with a small GGUF model, and pay-arkade built;
[Running Hive](running.md) lists the stack. Each run writes its steps and
outcome to `.local/rehearsal/service-<run>/result.json`. `test/rehearsal.ts` does the same for one
hive on a host of its own, and `test/buzz-approvals-e2e.ts` runs the keepers' part alone on the
stack, with the service and the plugin and no MeshLLM: two keepers fund a job, then withdraw from
the treasury.
