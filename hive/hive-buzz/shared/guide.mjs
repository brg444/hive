// What the Hive guide knows about how a hive works, and the instructions it starts with. The guide
// is a Goose agent the community owner adds in Buzz; the Hive plugin gives it this through the
// hive_guide tool and live figures through hive_status and hive_proposals. Inlined into the plugin.

export const GUIDE_NAME = "Hive guide";
export const GOOSE_TYPE = "buzz.goose/goose";

/** How a hive works, in the plugin's own words: what the guide answers questions from. */
export const HOW_IT_WORKS = `
How a hive works

A hive is a community's shared Bitcoin treasury for open AI. Members chip in, propose work, and
spend approved budgets on AI models that MeshLLM providers serve. Keepers hold the treasury's keys
together; any two of them sign each payment.

Proposals. A member posts a message starting with "Proposal:" in the hive's channel, with Budget,
For and Purpose lines (Work, Provider and Report are optional), or presses the hexagon button under
the message box. Members react 👍 to support it. Discussion runs 48 hours, or 24 hours under the
small-proposal threshold (20,000 sats unless the hive set another). Then two keepers react ✅ to
approve it; one keeper's ❌ with "Declined: <reason>" in the thread declines it. The proposer can
reply "Withdrawn" to stop it, and "Report: <link or text>" to close it out. An approved budget runs
from its dates, or 30 days from approval.

Allowances. A running proposal for "everyone", for named members or for the proposer gives each
of them a daily allowance. A member spends it through the hive's agent: from their own MeshLLM node
after posting "Hive node: <node id>" in the channel, or by asking the hive's agent.

Keepers. Keepers volunteer when HiveBot asks during setup, by reacting ✅, and the community owner
confirms them. Each keeper creates a treasury key in the keeper console: it is made on their own
device and locked with their passkey, and the key never leaves the device. The console then has
them save an encrypted backup file; the best place is iCloud Drive or Google Drive, with the
passphrase kept somewhere else, such as a password manager. File and passphrase together restore
the key on another device. A keeper then posts the line the console gives them, "Hive keeper key:
<key>", in the channel from their own account, which ties the key to them.

Payments. Approving a proposal and paying for its work are separate decisions. When a job needs
funding, keepers are notified in Buzz, open the request in the keeper console, check the amount,
the escrow, the provider and what is left of the budget, and sign with their passkey. Two keepers
sign; the first confirms once more to send it. Nobody, and nothing, signs for a keeper. Each job's
money sits in an escrow: the provider is paid what the agent's signed receipts show, the rest goes
back to the treasury, and an unclaimed escrow returns whole at its deadline with no one's signature.

Chipping in. Anyone can send sats to the hive's Lightning address or its treasury address from any
Lightning or Arkade wallet. Chip-ins are donations toward the hive's purpose and land in the
treasury as Bitcoin.

What nobody can do. No one moves treasury funds alone, keepers included. The plugin, HiveBot and the
guide hold no keys and cannot sign or move money.
`.trim();

/** The instructions the guide is created with. */
export const GUIDE_INSTRUCTIONS = `
You are the Hive guide for this community's hive: a shared Bitcoin treasury for open AI, kept in
this Buzz community. You answer members' and keepers' questions about how the hive works and where
it stands, and help them take the next step themselves.

Before you answer, call hive_guide for how the hive works, and hive_status or hive_proposals for
anything about the treasury, proposals, budgets, jobs or keepers. For details the guide does not
cover, such as safeguards, escrows, providers or the keeper console, call hive_docs with a topic: it
reads Hive's own documentation, and you can point people to the repository it comes from. Never state a number, a date, a
name or a decision you did not just read from those tools. If they do not have it, say you do not
know and who would: the keepers, or the community owner.

You cannot sign, move money or decide anything, and you never will. Never ask for, accept or repeat
a private key, a backup file, a passphrase or a recovery phrase; if someone shares one, tell them to
treat it as exposed and to create a new key in the keeper console. Point keepers to the keeper
console for keys and payments, and members to the Propose button or a "Proposal:" message for
proposals.

Write the way Buzz does: plain, second person and short, a few sentences at most, in flowing prose
rather than lists unless someone asks for steps, never opening a sentence with "And" or "But", and
always writing "Bitcoin" with a capital B.
`.trim();
