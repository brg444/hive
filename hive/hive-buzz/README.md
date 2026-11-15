# Hive for Buzz

A Buzz 1.0 plugin that puts a hive inside its community, the bot that announces what happens in
it, and the small read-only service that reports the treasury. The plugin shows and routes; it holds
no keys. It reads proposals, support and approvals straight from the hive's channel, so they work
as soon as it is installed. Proposing,
supporting and approving are ordinary Buzz messages and reactions, signed by whoever sends them.
Members chip in from their own wallets, and keepers approve each payment with a message in the
channel, which the plugin writes for them once it has checked the payment and which the treasury's
covenant checks itself.

- **Members** propose work from the hive's channel, see each proposal drawn as a card with its
  budget, period and live 👍 and ✅ counts, and find their own allowances on the hive's page.
- **Keepers** approve with ✅ or decline with ❌ and a reply. They hear once when a proposal's
  discussion closes without their decision, and once for each payment waiting for their approval,
  which they approve or decline from the hive's channel.
- **Agents** in the community get a `hive_status` tool that answers from the same data.

## On a Hive service

Most communities will use a Hive service rather than a host of their own: one service carries any
number of hives, each found by its channel, and one plugin built with `--service` serves them all.
[Running Hive for a Buzz community](../../docs/self-hosting.md) sets one up and walks a hive from
setup to a paid job. The sections below describe the pieces, and hive-api, which runs one hive on a
host of its own.

## hive-api

`api/` serves `GET /hive/v1/state` from what the hive already has: the agent's pay-arkade event
log (jobs, funding requests, claims and returns), the Arkade indexer (the treasury's balance) and
the LNURL server (settled chip-ins to the hive's address). One snapshot is cached for 15 seconds
whatever the number of members. It also passes on the Bitcoin price from mempool.space, for members who
read amounts in dollars; `--price-url` names another source, or `off`.

```bash
node api/src/server.mjs --name "Hive" --agent-log <pay-arkade buyer log> \
  --treasury <ark1... treasury address> --operator https://arkade.computer \
  --lightning-address <name>@lnurl.arkade.sh --lnurl-token-file <session.json> --port 8787
```

Run it behind TLS on the hive's host: Buzz lets a plugin call only the exact HTTPS origin its
manifest declares. To try the plugin on one machine, `--tls-cert` and `--tls-key` make hive-api
serve HTTPS itself with a locally trusted certificate (`mkcert localhost`). The Hive site can serve the same document later; the plugin needs nothing
else.

A hive's host has no Buzz key of its own, since a hosted community admits only its members' apps.
With `--channel`, the plugin in each member's app forwards the channel's signed events to
`POST /hive/v1/channel`, and hive-api keeps those whose signatures hold: a forwarded event cannot be
forged, only left out, and one open app is enough. From them it works out the proposals, the keepers
and their treasury keys, and writes the governance to `--governance` and the agent's members file
to `--members-file`, once a minute and whenever something new arrives.

```bash
node api/src/server.mjs --name "Hive" --agent-log <pay-arkade buyer log> --operator https://arkade.computer \
  --channel <channel ID> --bot <HiveBot's public key> --governance <file> --members-file <file> \
  --model <model id> [--treasury <ark1... address>] [--discussion-minutes <n>] \
  [--payments <the approvals desk's payments file>]
```

`--bot` takes the keepers HiveBot recorded during setup, in the order it confirmed them, which is
the order the treasury is built in; `--keepers` names them instead. Anyone can sign an event that
names the channel, and the host cannot see who is in it. So a member's node counts once HiveBot
acknowledged the message naming it or, on a host that knows only its keepers, once a keeper
reacted ✅ to that message; and the events of the bot, the keepers and everyone one of them has
mentioned, answered or acknowledged keep their place in the host's store, while everyone else's
share a smaller space of their own that a flood can fill without pushing the hive's events out.
hive-api also turns away more than a client's share of requests. A new hive runs without
`--treasury` until its keepers are confirmed and its treasury is built from their Buzz keys, and is
restarted with it. `--discussion-minutes` gives every proposal one short discussion, for a test
hive. `--payments` names the file the hive's approvals desk writes its payments to (`pnpm ops desk
<hive> --events <governance>.events.json --payments-file <file>`, which follows the keepers'
approvals in the events hive-api keeps), so the plugin shows keepers what waits for them.

The agent log also carries members' usage, which the state adds up per proposal without naming
members. Given `--agent-console http://127.0.0.1:3131` (the agent node's console, on the same host),
the state names the agent's node id, which members install with, and the page shows the install
line. Adding `--serve-invite` serves the agent's current mesh invite at `GET /hive/v1/invite`, read
fresh on every call because it changes when the agent restarts; providers and members keep their
`--join-file` current from it with `hive-join-sync.sh`, which ships in the pay-arkade archive. The
invite is never part of the state, and serving it is off unless asked for.

## Proposals in the channel

A proposal is a message in the hive's channel that starts with `Proposal:`. Any Buzz client can
read and write it; with the plugin, the composer's Propose button starts one and the channel shows
it as a card.

```
Proposal: Translate the Buzz docs into Spanish and Portuguese
Budget: 30,000 sats from 2026-11-15 to 2026-12-10
For: only me, 2,000 sats a day
Purpose: Buzz's docs exist only in English. The translated pages go to the docs repo.
Work: About 2.4 million tokens on llama-3.3-70b.
Report: A link to the merged pull request.
```

`For` is `only me`, `everyone`, or `named members` with the members mentioned. Without dates, a
budget runs 30 days from approval. Discussion stays open 48 hours, or 24 under the small-proposal
threshold (20,000 sats by default). Members support a proposal with 👍. Two keepers' ✅ approve it
once discussion closes; one keeper's ❌, with `Declined: <reason>` in the thread, declines it. The
proposer can reply `Withdrawn` to stop it, and `Report: <link or text>` to close it out. A member
links their MeshLLM node by posting `Hive node: <node id>` in the channel. The format lives in
`shared/proposal.mjs`, which the bot imports and the plugin build inlines, so both read a message
the same way.

## The plugin

```bash
node plugin/build.mjs --api https://hive.example.org --name "Hive" \
  --channel <the hive's channel ID> --keepers <npub>,<npub>,<npub> [--threshold 2] [--small-sats 20000]
```

writes `dist/<id>/manifest.json` and `plugin.js` for that hive. `--api` is hive-api's HTTPS address
and may carry a path; the manifest asks only for its origin. The channel ID is under View channel
details in Buzz. With `--channel` and `--keepers` the plugin knows the hive's channel and keepers by
itself; without them it takes them from hive-api, which has them when the bot coordinates. The community owner installs it in
the Buzz desktop app: Settings → Plugins → Manage plugins → Add → Browse, pick that folder, review
the one network origin it asks for, and install.

In the hive's channel it adds the proposal card, a status line above the composer (the treasury,
open proposals with the next decision, jobs waiting for keepers) and a Propose button that opens a
short form in its place; the form writes the proposal into the message box, and the member sends it.
For a keeper, a line above the composer lists the payments waiting for their approval, each checked
by the plugin, with Approve and Decline, and a Withdraw form; each writes the keeper's message into
the message box for them to send, and each approval in the channel draws as a card naming its
payment.
Amounts read in the unit each member picks in the plugin's card in Buzz's Settings: Bitcoin's
smallest unit written with the ₿ sign by default (₿1 is one sat), sats, BTC, or US dollars at the
price the host passes on. Messages in the channel and the agents' tools keep sats; `shared/amounts.mjs`
does the formatting.
It draws with Buzz's own design tokens, so it follows the app's light and dark themes, with Buzz's
amber for the hive's mark and anything still waiting on the community. The
hive's page has four tabs: an overview with the treasury, the viewer's allowances and live
proposals; every proposal; what waits for keepers; and the treasury, with chip-ins, payouts, jobs and
providers. It knows the viewer from the community's connection, and it uses Buzz's conversation
hooks, which Buzz describes as a preview rather than a stable cross-version interface.

Where each proposal stands, the plugin works out itself: it reads the channel's messages, reactions
and deletions from the last 90 days through the community connection Buzz already has (the same
event views Buzz's own plugins use) and applies the coordinator's rules, which the build inlines
from `bot/coordinator.mjs`. A reaction shows at once, and nothing else has to run for proposals,
approvals and allowances. If the plugin cannot read the channel, it falls back to the bot's record
from hive-api.

### HiveBot

The plugin also defines an agent type, Hive bot. The community owner creates HiveBot on Buzz's
Agents page and adds it to a channel; Buzz holds its key and signs it into the community, so it
posts as itself even where the community requires Buzz's sign-in. It needs no model and runs
while Buzz is open on the owner's computer. Mention it for where the hive stands. The owner sets a
hive up by mentioning it with "set up" (and, optionally, "with 2 keepers"): HiveBot then takes the
channel through the onboarding steps below, reading where it stands from its own tagged messages,
so it keeps nothing on disk and picks up after a restart. `--install <repository>#<branch>` at
build time tells members where to get the plugin.

### The Hive guide

For questions, HiveBot works with a guide: a Goose agent named Hive guide, on Buzz's own Goose
harness with whichever model the owner set up for Goose. The owner mentions HiveBot with "add a
guide", and HiveBot asks Buzz to create it with the guide's instructions from `shared/guide.mjs`,
for the owner to review on the Agents page. From then on, a question to HiveBot wakes the guide in
the same thread, while status and setup stay HiveBot's. The plugin gives every agent in the
community four tools: `hive_guide` (how a hive works, with this hive's own settings),
`hive_proposals`, `hive_status`, and `hive_docs`, which hands over the sections of the repository's
own documentation a question needs. The `Demo` workflow publishes that documentation beside the
demo state (`demo/make-docs.mjs`: the top-level README, how Hive works, this README and the payment
plugin's), and `--docs` at build time points the plugin at it; it must be on the origin the plugin
already calls. Mentioning HiveBot with "update the guide" asks Buzz to give an existing guide the
current instructions. The guide's instructions have it read them before answering,
state nothing they do not say, and never ask for or accept a key, backup or passphrase. HiveBot's
own messages stay the hive's record; the guide only explains.

### Trying it with the demo

`demo/make-state.mjs` writes a sample hive state, and the repo's `Demo` workflow publishes it on
GitHub Pages every six hours, so trying the plugin needs no host. The same workflow builds the
plugin against it for the channel and keepers in two repository variables, `HIVE_DEMO_CHANNEL` and
`HIVE_DEMO_KEEPERS` (npubs, comma-separated), and publishes it on the `plugin` branch. In Buzz,
Settings → Plugins → Manage plugins → Add → Add from Git, with the repository's GitHub address and
the branch `plugin`, installs it, and Check for updates picks up each new build.

Proposals then work for real in that channel; the treasury, jobs and payouts on the page are
sample data, marked as such, with addresses that no wallet accepts.

## Keepers' approvals

A keeper's key is their Buzz account's own: the treasury is built from the three keepers' Buzz keys,
and a keeper approves a payment by sending `I approve Hive payment <code>` in the hive's channel,
whose code names the treasury, the payment's number, amount and recipient and the time the approval
lapses. Buzz signs it as it signs any message, and the treasury's covenant rebuilds the message and
checks the signature itself. `I decline Hive payment <code>` stops a payment, and
`Hive withdrawal: <amount> sats to <Arkade address>`, from a keeper, asks for one.

The plugin does the checking and the writing. For each payment the hive's approvals desk has waiting
(on the Hive service, or from `pnpm ops desk` beside hive-api), it rebuilds the job's escrow from its
terms with the hive's own code, checks that it gives back to this treasury and that the amount is
the job's cap, or works out what a withdrawal's address pays, and rebuilds the exact message the
covenant will check. Only then does it offer Approve, which writes that message into the message
box for the keeper to send as it is. On mainnet it also holds the host to the Arkade Operator's and
Emulator's keys it was built with. What approved work has left is the desk's count: the plugin
cannot check it against the channel, so a keeper reads the proposal there before approving.

`plugin/checks.mjs` is that code: `packages/ark` and `packages/treasury`, which `plugin/build.mjs`
bundles into `plugin.js` with esbuild, so the build needs the repository's `pnpm install` and this
folder's `npm ci`. It runs only when a keeper looks at a payment, and the build comes out the same
byte for byte from the same commit. The repository's `test/buzz-approvals-e2e.ts` has two keepers
fund a job and a withdrawal on regtest with this plugin's own checks and messages, and
`test/rehearsal-service.ts` runs two whole hives on a Hive service on regtest.

## The hive's bot

The plugin does not need the bot. The bot posts what happens in the hive for everyone in the
channel, with or without the plugin, and writes the members file the hive's agent spends by.

`bot/hive-bot.mjs` posts what happens in the hive into its Buzz channel as an agent of its own:
funding requests for keepers (at once, even on its first run), jobs opening, providers paid with
what went back to the treasury, unused escrows returned, lapsed or declined requests, chip-ins, a
treasury that falls under a floor, and a summary of each month on the first run of the next. It
reads only hive-api's public state, so it can run on any machine that reaches hive-api; the hive's
receipt key and its Buzz key never need to share a host. It posts through Buzz's agent CLI, `buzz`,
which handles request signing and the relay's owner check. The Buzz desktop app ships that CLI
inside itself, and on a Mac with Buzz installed the bot uses it without being told; elsewhere, pass
`--buzz <path>` or build it from block/buzz with `cargo build --release -p buzz-cli`.

```bash
node bot/hive-bot.mjs init --state ~/.hive-bot          # makes the bot's key, prints its public key
# In the Buzz desktop app: Settings → Buzz → Security → Authorize external identity, paste the key,
# copy the authorization it shows.
node bot/hive-bot.mjs authorize --state ~/.hive-bot --auth-tag '<the authorization>'
node bot/hive-bot.mjs profile --state ~/.hive-bot --relay https://<community> --name "Hive"
# Add the bot's public key to the hive's channel with the role "bot", then:
node bot/hive-bot.mjs run --state ~/.hive-bot --relay https://<community> --channel <channel UUID> \
  --api https://<hive-api host> --low-treasury-sats 20000
```

With `--keepers` (npubs as Buzz shows them, or hex keys, comma-separated) the bot also
coordinates. Each pass it reads the channel's
messages, reactions and deletions from the last 90 days (`--since-days`), works out where each
proposal stands by the same rules as the plugin, and writes it to `state/governance.json`
(`--governance-file`), which hive-api serves when started with `--governance <file>`. With `--members-file <path>` it also
writes the agent's members file: each member who named a node, with the running proposal they may
spend from and its daily allowance. It posts each approval, decline and close once. `--threshold`
and `--small-sats` change the two numbers above, and `--as-of <unix seconds>` judges proposals as
of another time, for rehearsing a decision without waiting out its discussion. For a plugin built without
`--channel`, `hive-bot seed --state <dir> --channel <UUID> --keepers <npub,npub>` writes a
governance file with just the channel and keepers for hive-api to serve.

### Setting a hive up from its channel

With `--onboard`, the bot sets the hive up in its channel, and every answer is a ✅ or a message:

1. It asks who will keep the treasury, and each keeper reacts ✅ (`--keepers-needed`, 3 by default).
2. Once enough have, the member who authorized the bot confirms them with ✅.
3. It posts the plugin, built for that channel and those keepers, as an attachment, and tells the
   keepers that their Buzz accounts are their keys: each approves payments with a message in the
   channel, and backs their Buzz key up in Settings → Identity.
4. It says what happens with the treasury, which the host builds from the keepers' Buzz keys, and
   posts the chip-in address once hive-api has one.
5. It shows the proposal format, and closes the setup when the first proposal arrives.

Nobody copies a key or a channel ID: the bot reads them from the signed reactions and from the
channel it is in. From the confirmation on, it coordinates with those keepers as with `--keepers`.
`--plugin-api` gives the plugin hive-api's public HTTPS address when the bot reaches it at another,
such as `http://127.0.0.1:8787` on the same host. `test/onboard-relay-e2e.mjs` runs the whole setup
against a real relay.

The bot checks the authorization against its own key before keeping it, and the relay admits the
bot only through it: a member must authorize the key, and the messages then show as the bot's,
authorized by that member. Buzz lets the holder of an authorized key direct the authorizing
member's own Buzz coding agents, so the authorization should come from an identity that runs none,
such as one kept for the hive. Each message is recorded as said only once the relay accepts it, so
a failed post is retried on the next pass and nothing is said twice.

`node test/bot-relay-e2e.mjs --relay <url> --owner-key-file <file> --member-key-file <file> --buzz
<buzz CLI>` runs the bot against a real, membership-gated relay (block/buzz's `deploy/compose`): an
unauthorized bot is refused, an authorized one posts, and each message carries the member's
authorization. Its second part proposes in the channel, supports it, names a node and approves it
as two keepers, then checks that hive-api serves the decision, that the members file lets the node
spend, and that the approval is announced once.

## Tests

```bash
npm test
```

runs the state derivation against real agent logs (a regtest run and the November 12 mainnet run),
then activates the built plugin in a stand-in for Buzz's API v1 host against a live hive-api:
manifest rules, registration, the agent tool, rendering with real data, the proposal card, the
Propose button and the status line, the viewer's allowances, the keepers' notifications, and the
error state when the hive is unreachable, and a keeper's payments: the approval the plugin offers,
worked out byte for byte as the covenant rebuilds it, a payment it refuses, and the approval card.
`test/governance.test.mjs` covers the proposal format and
the coordinator: support, approval after discussion, declines with reasons, withdrawals, removed
reactions and the members file. Behind a proxy, set `NODE_USE_ENV_PROXY=1`.
`node --import tsx hive/hive-buzz/test/preview.mjs <out.html> [--buzz-app <block/buzz-app checkout>] [--dark]`, from the repository's root, renders the proposal card, an approval, the payments waiting for a keeper, the status line, the Propose form and the page with sample data, in Buzz's own design tokens when given its checkout, for screenshots.

Not yet exercised: the plugin inside the Buzz app itself, which only runs on desktop.
