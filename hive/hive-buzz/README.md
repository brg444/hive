# Hive for Buzz

A Buzz 1.0 plugin that puts a hive inside its community, the bot that coordinates it, and the
small read-only service both read from. The plugin shows and routes; it holds no keys. Proposing,
supporting and approving are ordinary Buzz messages and reactions, signed by whoever sends them.
Chipping in and funding jobs happen in each person's own wallet.

- **Members** propose work from the hive's channel, see each proposal drawn as a card with its
  budget, period and live 👍 and ✅ counts, and find their own allowances on the hive's page.
- **Keepers** approve with ✅ or decline with ❌ and a reply. They hear once when a proposal's
  discussion closes without their decision, and once for each job waiting for funding, with the
  exact amount, the escrow address and the earliest coin expiry the provider accepts.
- **Agents** in the community get a `hive_status` tool that answers from the same data.

## hive-api

`api/` serves `GET /hive/v1/state` from what the hive already has: the agent's pay-arkade event
log (jobs, funding requests, claims and returns), the Arkade indexer (the treasury's balance) and
the LNURL server (settled chip-ins to the hive's address). One snapshot is cached for 15 seconds
whatever the number of members.

```bash
node api/src/server.mjs --name "Hive" --agent-log <pay-arkade buyer log> \
  --treasury <ark1... treasury address> --operator https://arkade.computer \
  --lightning-address <name>@lnurl.arkade.sh --lnurl-token-file <session.json> --port 8787
```

Run it behind TLS on the hive's host: Buzz lets a plugin call only the exact HTTPS origin its
manifest declares. To try the plugin on one machine, `--tls-cert` and `--tls-key` make hive-api
serve HTTPS itself with a locally trusted certificate (`mkcert localhost`). The Hive site can serve the same document later; the plugin needs nothing
else.

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
node plugin/build.mjs --api https://hive.example.org --name "Hive"
```

writes `dist/<id>/manifest.json` and `plugin.js` for that hive. The community owner installs it in
the Buzz desktop app: Settings → Plugins → Manage plugins → Add → Browse, pick that folder, review
the one network origin it asks for, and install.

In the hive's channel it adds the proposal card, a status line above the composer (the treasury,
open proposals with the next decision, jobs waiting for keepers) and a Propose button that opens a
short form in its place; the form writes the proposal into the message box, and the member sends it.
It draws with Buzz's own design tokens, so it follows the app's light and dark themes, with Buzz's
amber for the hive's mark and anything still waiting on the community. The
hive's page has four tabs: an overview with the treasury, the viewer's allowances and live
proposals; every proposal; what waits for keepers; and the money, with chip-ins, payouts, jobs and
providers. It knows the viewer from the community's connection, and it uses Buzz's conversation
hooks, which Buzz describes as a preview rather than a stable cross-version interface.

## The hive's bot

`bot/hive-bot.mjs` posts what happens in the hive into its Buzz channel as an agent of its own:
funding requests for keepers (at once, even on its first run), jobs opening, providers paid with
what went back to the treasury, unused escrows returned, lapsed or declined requests, chip-ins, a
treasury that falls under a floor, and a summary of each month on the first run of the next. It
reads only hive-api's public state, so it can run on any machine that reaches hive-api; the hive's
receipt key and its Buzz key never need to share a host. It posts through Buzz's agent CLI (`buzz`,
built from block/buzz with `cargo build --release -p buzz-cli`), which handles request signing and
the relay's owner check.

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
proposal stands, and writes it to `state/governance.json` (`--governance-file`), which hive-api
serves to the plugin when started with `--governance <file>`. With `--members-file <path>` it also
writes the agent's members file: each member who named a node, with the running proposal they may
spend from and its daily allowance. It posts each approval, decline and close once. `--threshold`
and `--small-sats` change the two numbers above, and `--as-of <unix seconds>` judges proposals as
of another time, for rehearsing a decision without waiting out its discussion. Before the bot runs,
`hive-bot seed --state <dir> --channel <UUID> --keepers <npub,npub>` writes a governance file with
just the channel and keepers, which is enough for the plugin's card, Propose button and status line
to appear in that channel.

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
error state when the hive is unreachable. `test/governance.test.mjs` covers the proposal format and
the coordinator: support, approval after discussion, declines with reasons, withdrawals, removed
reactions and the members file. Behind a proxy, set `NODE_USE_ENV_PROXY=1`.
`node test/preview.mjs <out.html> [--buzz-app <block/buzz-app checkout>] [--dark]` renders the proposal card, the status line, the Propose form and the page with sample data, in Buzz's own design tokens when given its checkout, for screenshots.

Not yet exercised: the plugin inside the Buzz app itself, which only runs on desktop.
