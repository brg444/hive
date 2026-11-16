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
which Buzz keeps on each keeper's device and signs their messages with. Buzz makes each key at random
when the identity is created, or takes one the member imports as an `nsec`, and keeps it in the
system's secure storage. Hive uses the public key as it is, derives no other key from the secret and
never sees it; the README describes [how the treasury is built from the three
keys](README.md#from-a-buzz-identity-to-the-treasury). The treasury's covenant
checks each keeper's approval itself, as their signature over a channel message whose text says the
amount and the start of the recipient, and whose code names the payment's number, amount, recipient
and lapse time, so any two keepers fund a job or withdraw from the treasury and one alone moves
nothing. Two keepers who agree can send the treasury anywhere, and nothing in the code stops them:
that is what a 2-of-3 treasury is. A Buzz key is a software key, not one bound to the device's
hardware, and approving asks for no fingerprint or face: whoever holds a keeper's key, from that
keeper's device or from Buzz's key backup if they turned it on, approves as that keeper. An approval
is a sentence, and it counts from any channel and any client: whatever makes a keeper's Buzz send
that sentence approves the payment it names, which is why it says the amount in words, and why a
keeper sends none their plugin did not write. A sent approval cannot be withdrawn, only left to
lapse, within a day at most. A decline, or deleting the message, stops the hive's desk from paying;
it does not reach approvals two keepers have already sent, which anyone who read them in the channel
can still submit until they lapse. An approval names the payment's number, so a payment approved
under two numbers could pay under both: the desk therefore opens one payment at a time, under the
treasury's current number, and a keeper's plugin offers the same payment under one number only. A
keeper who loses their key, with no backup, loses their part of the treasury, including the key on
its exit; the other two still move funds.

**The Operator and the Emulator.** Ark Labs' services co-sign every spend of the treasury and of
each escrow, and the Emulator is where the covenants run: it checks a keeper's approval before it
signs, where Bitcoin's own rules check only the two services' signatures, and it reads an approval's
lapse from its own clock. On mainnet their keys are pinned in `packages/ark/src/deployment.ts`, and a
keeper's Hive plugin refuses a payment from a host that names others. Neither can move funds alone.
The two together hold every leaf of the treasury but its exits, so they are trusted not to act
together against it, as with any covenant on Arkade; if they stop, funds leave by the exit path, for
which this repository has no tooling yet.

**The host.** It holds no key that moves a treasury. Its approvals desk reads the keepers' approvals
from the channel, as members' plugins forward it, and submits each payment once two are in, and it
holds the delegatee's delegate key, the only cosigner the treasury's renewal accepts, which renews
the treasury's coins and cannot spend them elsewhere. It also issues each hive's counter from an
issuer wallet of its own and sends the whole supply to the treasury. The covenant merges no coin that
holds units of the counter, so nothing the issuer keeps or makes later can change the treasury
coin's payment number. What the covenant cannot do is count the units that exist: a host that issued
more than it sent could put a second coin with units of its own on the treasury's script, where the
same approvals would pay once more from whatever that coin held. `pnpm ops counter` asks the
Operator's indexer for the supply issued and whether anything can issue more, for anyone who wants
to see, and the first payment's number, which the covenant checks against the coin, shows the
treasury was sent all of it. A dishonest or broken host can do these things:

- Describe a payment that is not what it says. The keeper's Hive plugin, installed in their own
  Buzz and not served by the host, rebuilds every payment before it offers the approval: the treasury
  from the keepers' keys and the terms the host states, the job's escrow from its own terms and that
  it pays back to that treasury, or the withdrawal's address and the keeper's message that asked for
  it, and the exact message the covenant checks. On mainnet it holds a job to the ceiling on an
  escrow. An approval the host asked for under another description names another payment, and pays
  nothing.
- Hold approvals back, or submit them late. An approval pays only its own payment, once, and only
  until it lapses.
- Ask for the same payment twice, under two numbers. The plugin offers a keeper the same amount to
  the same recipient once a day, whatever number the host puts on it.
- Report usage that is not the hive's. The plugin holds a job to the budgets of the proposals it
  reads in the channel itself, less the usage the host reports: the host can understate what was
  used, and cannot ask for more than the channel approved. Keepers read the proposal in the channel
  before they approve.
- Run an agent that is not the hive's. A job's receipts are signed by the agent its escrow names,
  which the plugin shows, remembers from the first job a keeper funds, and holds later jobs to.
- Name an address of its own for chip-ins. A keeper's plugin compares the address members are shown
  with the treasury it rebuilt, each time it checks a payment; a member who is not a keeper has the
  host's word and HiveBot's message.
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

The escrow and treasury scripts have had no formal review. The plugin built once for a whole
service takes a hive's keepers from the host, where the one HiveBot posts for a hive carries them.
No keeper's plugin asks the Operator's indexer about the counter itself: that check is a command
someone runs. The exit path has no tooling: the exit leaves check two keepers' signatures with
their own Buzz keys, and nothing here signs one yet. A keeper cannot be replaced without building a
new treasury and withdrawing to it. The v5 treasury does not yet sign the hive's directory listing.
The flow has run end to end on regtest and in pieces on mainnet, never whole on mainnet, and the
treasury's contract and desk as they now stand have run in the Emulator's interpreter and against a
stand-in for the treasury, not yet on regtest.
