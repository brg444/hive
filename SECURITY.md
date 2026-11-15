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

**The keepers.** Three Buzz accounts, one per keeper: the treasury is built from their Buzz keys,
which Buzz keeps on each keeper's device and signs their messages with. The treasury's covenant
checks each keeper's approval itself, as their signature over a channel message whose text names the
payment's number, amount, recipient and lapse time, so any two keepers fund a job or withdraw from
the treasury and one alone moves nothing. Two keepers who agree can send the treasury anywhere, and
nothing in the code stops them: that is what a 2-of-3 treasury is. A Buzz key is a software key, not
one bound to the device's hardware, and approving asks for no fingerprint or face: whoever holds a
keeper's key, from that keeper's device or from Buzz's key backup if they turned it on, approves as
that keeper. A sent approval cannot be withdrawn, only left to lapse. A keeper who loses their key,
with no backup, loses their part of the treasury, including the key on its exit; the other two still
move funds.

**The Operator and the Emulator.** Ark Labs' services co-sign every spend of the treasury and of
each escrow. On mainnet their keys are pinned in `packages/ark/src/deployment.ts`, and a keeper's
Hive plugin refuses a payment from a host that names others. They cannot move funds on their own; if they stop, funds leave
by the exit path, for which this repository has no tooling yet.

**The host.** It holds no key that moves a treasury. Its approvals desk reads the keepers' approvals
from the channel, as members' plugins forward it, and submits each payment once two are in, and it holds the delegatee's delegate key, the only
cosigner the treasury's renewal accepts, which renews the treasury's coins and cannot spend them
elsewhere. It also issues each hive's counter from an issuer wallet of its own and sends the whole
supply to the treasury, after which the treasury is the only holder of the counter and the issuer has
no further part. A dishonest or broken host can do these things:

- Describe a payment that is not what it says. The keeper's Hive plugin, installed in their own
  Buzz and not served by the host, rebuilds every payment before it offers the approval: the job's
  escrow from its own terms and that it pays back to this treasury, or the withdrawal's address, and
  the exact message the covenant checks. An approval the host asked for under another description
  names another payment, and pays nothing.
- Hold approvals back, or submit them late. An approval pays only its own payment, once, and only
  until it lapses.
- Report a budget that is not the channel's. The plugin checks a payment's escrow, recipient and
  amount itself, yet what approved work has left comes from the desk. Keepers read the proposal in
  the channel before they approve.
- Withhold: refuse to carry approvals, stop renewing, or go away. The keepers' keys are not on it,
  and its state is in the backups it writes; see [Running Hive](docs/self-hosting.md) for a restore.
- Approve a request for a hive that did not come from the community's HiveBot. The operator names
  HiveBot's key from the channel when approving, and HiveBot checks the hive is its own before it
  announces a treasury.

**The channel.** Proposals, reactions and keepers' approvals of payments are signed Buzz events. A host that has a
channel forwarded to it checks every signature, though it cannot see who is in the channel. So it
counts only what the hive's bot or keepers stand behind (a member's node once the bot or a keeper
acknowledged it, a proposal once keepers approved it), and keeps events from keys nobody in the
hive has answered in a bounded space of their own.

**The agent.** Each hive's agent node holds a receipt key. It can pay a job's provider up to the
cap the keepers funded for that job, and nothing more. Keepers see each job's model, provider and
deadline in their plugin before they approve its funding. On a host, every hive's agent
node runs as the same user as the service; a community that wants its agent apart runs its own.

**A provider.** It is paid what the agent's latest receipt says, up to the job's cap, and the rest
returns to the treasury at the deadline with nobody signing. It counts the tokens of each answer
itself; the agent signs for that count only up to what the request could have cost. A buyer names
the providers it pays for that reason.

## What is not covered

The escrow and treasury scripts have had no formal review. The exit path has no tooling: the exit
leaves are MuSig2 keys over the keepers' Buzz keys, and nothing here signs with them yet. A keeper cannot be replaced without building a new treasury and withdrawing to it. The v5
treasury does not yet sign the hive's directory listing. The flow has run end to
end on regtest and in pieces on mainnet, never whole on mainnet.
