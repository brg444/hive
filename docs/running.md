# Running Hive

Every command runs from the repository root. You need Node 22 or later and
pnpm 10. `pnpm vectors:check` also needs Go 1.26 and the delegatee source that
`tools/delegatee.sh` clones, and the MeshLLM tools need Python 3.

## Without a network

```bash
pnpm install
pnpm check                 # format, lint, typecheck and every test, none skipped
pnpm dev                   # the site with three sample hives at http://127.0.0.1:8790/
pnpm vectors:check         # contract, spend and protocol vectors against their generators
pnpm gates:offline         # the three gates against the in-memory network
pnpm audit:v4 --offline    # recheck what those gates wrote
```

Nothing here moves value. The gates and the offline audit write under
`.local/offline-evidence/`, or under `BUZZ_EVIDENCE_ROOT` when it names a
directory inside `.local/`. The lifecycle gate takes about four minutes, because
it waits out an unused escrow's deadline.

## A hive on a test network

A regtest hive needs an Arkade Operator and Emulator (v0.0.9-rc.0 or later), a
delegatee beside them for renewals and deadline refunds (`tools/delegatee.sh`,
whose header lists its settings), and MeshLLM (`pnpm mesh:start`). Point the
tools at them:

```bash
export BUZZ_ARKD_URL=http://localhost:7070 BUZZ_DELEGATEE_URL=http://localhost:7090
export BUZZ_EMULATOR_URL=http://localhost:7073
```

On Mutinynet the services are pinned in the code, and every run needs
`BUZZ_MUTINYNET=approved`. Mainnet is refused.

## Operating a hive

`pnpm ops` runs hives from a checkout. Records go under `.local/ops/<hive>/` and
keys under `.secrets/`, both ignored by git.

| Command | Does |
| --- | --- |
| `pnpm ops init <hive> --network <regtest\|mutinynet> [--lnurl <url>]` | Creates the keys, the treasury and the Lightning address |
| `pnpm ops listing <hive> --name <name> [--purpose <text>] [--relay <url> …]` | Writes the hive's signed listing, and publishes it when relays are given |
| `pnpm ops publish <hive> --relay <url> [--relay <url> …]` | Publishes the newest listing to Nostr relays |
| `pnpm ops hives --network <regtest\|mutinynet> --relay <url> […]` | Lists the hives those relays carry whose keys build the treasury they name |
| `pnpm ops provider-add <hive> <provider> --model … --input-rate … --output-rate … --relay …` | Creates a provider: payout wallet, card and solver configuration |
| `pnpm ops provider-serve <hive> <provider>` | Runs the provider's solver |
| `pnpm ops approve <hive> <label> --provider … --cap … --minutes …` | Approves one job's exact terms for every party |
| `pnpm ops buy <hive> <label>` | Gets the quote, arranges the refund and funds the escrow |
| `pnpm ops escrow <hive> <label> [--desk <url>]` | Runs the sidecar, the agent and the claim daemon until the job closes |
| `pnpm ops serve <hive> [--port 8080]` | Serves one hive and its claim desk at `/api/claim` |
| `pnpm ops host <hive> [<hive> …] [--port 8080]` | Serves several hives under one directory, with one claim desk |
| `pnpm ops status <hive>` | Prints the hive's balance, jobs and warnings |
| `pnpm ops withdraw <hive> <label> --to <address> --amount <sats\|all>` | Pays treasury coins to an approved address |
| `pnpm ops payout <hive> <provider> <label> --to <address> --amount <sats\|all>` | Sends from a provider's payout wallet |
| `pnpm ops cashout <hive> <provider> <bolt11>` | Pays a Lightning invoice from the payout wallet |
| `pnpm ops halt [--hive <hive>] <reason>` / `pnpm ops resume [--hive <hive>]` | Stops or restarts new jobs and contributions |

Two stops need no code change. `COINS_RENEWING` means the coins a send needs
are about to renew; send again once they have. `RENEWALS_DISABLED` means the
delegatee stopped renewing an account's coins after repeated refusals; its
administrator turns renewals back on, and `pnpm ops status` warns of it.
