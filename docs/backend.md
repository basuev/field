# Local task API

This foundation stores canonical quotes and one immutable report per task. It reads finalized Solana devnet evidence but cannot sign, broadcast, fund or settle anything. `executionAvailable` stays false until a separately verified deployment and complete wallet flow exist. The phone report page and agent adapter are not connected yet.

## Run locally

Use Node.js 22.12 or newer and a running Docker daemon.

```sh
npm ci
docker compose up -d postgres
cp .env.example .env
```

Set three distinct test-wallet public addresses in `.env`. Never put a wallet seed or private key there. Generate two independent API secrets and use the output for `FIELD_REQUESTER_TOKEN` and `FIELD_CAPABILITY_SECRET`.

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex")); console.log(randomBytes(32).toString("hex"));'
npm run server
```

The API binds only to loopback and rejects foreign Host headers. The Compose database also publishes only a loopback port. Its example password is for isolated local development, not a remotely accessible database. Do not expose this API through the wallet-check tunnel.

Startup applies SQL migrations transactionally. `npm run server:migrate` applies them without starting HTTP. Applied migration checksums are verified, so add a migration rather than editing one used by a persistent database. The Compose volume survives process restarts. `docker compose down -v` destroys its stored tasks and reports and must not be used as recovery for a funded task.

## Request a quote

Load the requester credential into the shell from your private configuration. Keep it out of URLs, source control and agent conversation transcripts. A request key is a canonical lowercase UUID chosen by the caller.

```sh
curl --fail-with-body http://127.0.0.1:3001/v1/tasks \
  -H "Authorization: Bearer $FIELD_REQUESTER_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"idempotencyKey":"00112233-4455-4677-8899-aabbccddeeff","cafe":{"name":"Example cafe","address":"Example address"}}'
```

The requester must eventually approve the returned complete task, not only its price. The current quote windows are demo defaults, not a promise that an inspection will finish within them. They become absolute terms in the canonical task. A retry with the same key and cafe returns those original terms even after expiry or configuration changes. Reusing the key for different input returns `409`. Requesting a fresh quote requires a new explicit key. Reads never create another task.

The private creation response contains executor and reviewer bearer credentials scoped to that task. These grant offchain access, not ownership of a wallet or authority to move funds. Preserve the capability secret across restarts if existing invitations should remain usable. Rotating it invalidates those invitations without cancelling tasks or changing onchain rights. The separate requester credential can rotate independently.

## Read and lock a report

Read `GET /v1/tasks/<id>` with the requester credential or that task's role credential. Ordinary reads do not return invitations for other roles.

Only the executor invitation may `POST /v1/tasks/<id>/report` with a complete [canonical report](encoding.md). The first successful upload permanently locks its preimage. It is not a mutable draft. Anyone holding the invitation can consume that slot, so keep the credential private and review content before uploading. An identical retry is harmless. Different content returns `409`.

The executor can retrieve their own locked report before commitment. Requester and reviewer reads disclose the report only when verified finalized account evidence matches its hash. SQL storage does not mean the executor submitted it onchain. `reportStored` and `reportCommitted` deliberately express different facts. Report times remain executor assertions, not chain-proven observations.

## Chain evidence

Read responses separate retained business state, last verified snapshot and current RPC health. Missing or failed RPC reads never erase an earlier funded or terminal outcome. The last observed context slot is retained even for absent or conflicting evidence, so an older delayed response cannot clear newer uncertainty. Recovery from contradictory evidence needs a newer corroborating observation. A terminal refund without a report cannot acquire one later.

The periodic reader does not overlap itself. Quoted tasks remain eligible for reconciliation after quote expiry because earlier valid funding may become visible later. No reconciler operation signs or resubmits a transaction. Funding and submission need a separate durable pending-operation journal before wallet integration is enabled.

## Tests

```sh
npm run test:server
```

The suite creates and removes an isolated disposable PostgreSQL container. It verifies concurrent idempotency, immutable reports, role boundaries and out-of-order reconciliation with controlled chain responses. Reader tests verify genesis binding and finalized account decoding. These tests do not establish a live devnet task, a deployment or a working mobile report flow.
