# Field

Real-world tasks for AI agents.

Field is a proposed service that lets a personal AI agent commission a nearby human to check physical-world conditions and bring the report back to the same agent conversation.

## Demo target

One complete task, from a request to settlement.

1. The agent requests a quote for a specific inspection.
2. The requester reviews the scope, price and deadlines and signs funding in a wallet.
3. The designated executor acknowledges the task and performs the inspection.
4. The executor submits a timestamped report, which the agent retrieves.
5. The requester accepts the completed work and authorizes payment to the executor.

The first use case is checking whether a cafe is suitable for laptop work. The personal agent remains the entry point rather than a separate consumer chat application.

## Constraints

- A report describes an observation, not a reservation or a guarantee of future conditions.
- A negative finding can still fulfill the inspection task.
- Models never receive wallet private keys or independently authorize spending.
- Orders persist when the personal agent closes. Retrieving a result must not create another paid task.
- Reports are untrusted input. Financial disputes require an explicit human review policy.
- Solana holds and settles funds. It cannot establish whether an observation is true.

## Wallet check

The runnable application checks Phantom signing and finalized Solana devnet execution using a memo transaction. There is no transfer or escrow. Only a fee in test SOL is charged.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173 with Phantom in Testnet Mode. Phone wallet access requires HTTPS. The check persists transaction evidence before submission and does not authorize any task payment. An uncertain outcome must be checked, not replaced with another signature.

```sh
npx playwright install chromium
npm run check
```

Automated wallet and RPC responses are simulated. They do not establish that a real phone signature works.

## Implementation boundary

The shared [task/report commitments](docs/encoding.md), transaction instruction builders and Rust escrow source are separate from the wallet check. The task-wallet library is not yet connected to a complete user flow. See [escrow development](docs/escrow.md) for local tests and the deployment safety boundary.

The local [task API](docs/backend.md) persists quotes and immutable reports, enforces role access and reconciles finalized chain evidence. It has no signing or transaction-submission endpoints. The executor phone flow and agent adapter are not implemented. The escrow is not deployed, and no task-funding UI is connected. Do not use the wallet check with real funds or present it as a complete Field task.
