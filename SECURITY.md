# Security

Hive is a proof of concept. It is not maintained as a product, and nobody stands behind a
deployment but whoever runs it. Read this before putting funds that matter in a treasury.

## Reporting a problem

If you find a way to move, freeze or misdirect funds, or to make a keeper sign something they did
not read, report it privately first: use "Report a vulnerability" under the Security tab of the
repository you got the code from, or of the fork whose host you use. For anything else, open an
issue. There is no bounty.

A fork that runs a host for others should say here who answers reports about that host.

## What each part is trusted with

**The keepers.** Three keys, made in each keeper's own console and kept on their device behind a
passkey. Any two fund a job or withdraw from the treasury; one alone moves nothing. Two keepers who
agree can send the treasury anywhere, and nothing in the code stops them: that is what a 2-of-3
treasury is.

**The Operator and the Emulator.** Ark Labs' services co-sign every spend of the treasury and of
each escrow. On mainnet their keys are pinned in `packages/ark/src/deployment.ts`, and a console
refuses a desk that names others. They cannot move funds on their own; if they stop, funds leave
by the exit path, for which this repository has no tooling yet.

**The host.** It holds no key that moves a treasury. It carries the keepers' signatures between
their consoles, forwards signed payments to the delegatee, and holds the delegatee's delegate key,
which renews the treasury's coins and cannot spend them elsewhere. A dishonest or broken host can
do these things:

- Serve a keeper console other than the one in this repository. The console is where a key is
  unlocked, so this is the host's one way to a keeper's key. The build is reproducible, the page
  names its script by hash, `keeper/verify.mjs` compares a host's copy with a checkout's build,
  and a keeper can serve the console from their own machine with `keeper/serve.mjs`.
- Report a budget that is not the channel's. The console checks a payment's escrow, coins and
  amount itself, and holds mainnet payments under a fixed ceiling, yet what approved work has left
  comes from the desk. Keepers read the proposal in the channel before they sign.
- Withhold: refuse to carry signatures, stop renewing, or go away. The keepers' keys are not on it,
  and its state is in the backups it writes; see [Running Hive](docs/self-hosting.md) for a restore.
- Approve a request for a hive that did not come from the community's HiveBot. The operator names
  HiveBot's key from the channel when approving, and HiveBot checks the hive is its own before it
  announces a treasury.

**The channel.** Proposals, approvals and keepers' keys are signed Buzz events. A host that has a
channel forwarded to it checks every signature, though it cannot see who is in the channel. So it
counts only what the hive's bot or keepers stand behind (a member's node once the bot or a keeper
acknowledged it, a proposal once keepers approved it), and keeps events from keys nobody in the
hive has answered in a bounded space of their own.

**The agent.** Each hive's agent node holds a receipt key. It can pay a job's provider up to the
cap the keepers funded for that job, and nothing more. A keeper's console shows the agent's key,
remembers it, and asks before signing for a job that names another. On a host, every hive's agent
node runs as the same user as the service; a community that wants its agent apart runs its own.

**A provider.** It is paid what the agent's latest receipt says, up to the job's cap, and the rest
returns to the treasury at the deadline with nobody signing. It counts the tokens of each answer
itself; the agent signs for that count only up to what the request could have cost. A buyer names
the providers it pays for that reason.

## What is not covered

The escrow and treasury scripts have had no formal review. The exit path has no tooling. A keeper
cannot be replaced without building a new treasury and withdrawing to it. The flow has run end to
end on regtest and in pieces on mainnet, never whole on mainnet.
