# Escrow development

This is a devnet-only application integration. The program source does not identify its cluster. An operator could deploy the same code on another cluster, so clients must keep genesis verification and explicit wallet-chain binding. A hash containing `solana:devnet` is domain separation, not a runtime cluster check.

Run the shared format and wallet checks with `npm run check`. Run Rust transition and wire-compatibility tests with `npm run test:escrow`. Their dependencies are frozen in the root `Cargo.lock`.

Install the pinned SBF build tool before running the heavier runtime suite.

```sh
cargo install cargo-build-sbf --version 4.4.0 --locked --root target/toolchain
npm run test:escrow:runtime
```

The command first builds the Solana ELF artifact and then loads it into `solana-program-test`. It executes actual SBF handlers, account constraints, system transfers and rollback under a 200,000-unit compute limit. There is no native-handler fallback. Role-address validation uses Solana's curve syscall rather than software decompression inside the program. The build tool downloads its platform toolchain on first use.

The runtime dependencies are frozen in `tests/escrow-runtime/Cargo.lock`, separately from the lighter core workspace. Generated local wallets and bank balances are test fixtures. These tests contact no public RPC. `npm run check:all` also includes the PostgreSQL integration suite and needs Docker.

A loaded executable fixture account is not a deployment through the upgradeable loader or a standalone local-validator RPC run. Before devnet task funding, exercise the artifact and signing client through a local validator, deploy the program and verify its executable identity and upgrade authority. A successful core test run alone does not establish SBF compatibility.

The program identity is bound into the canonical task. The local deployment key is kept under the ignored `secrets/` directory and must not be copied into source, fixtures or agent messages. A fresh clone does not contain that key. Wallet seeds are never deployment configuration.

Do not run deployment commands with a mainnet profile. `Anchor.toml` defaults to localnet. Its local-validator wallet path must be created separately using a new disposable local key, never a personal wallet seed. The Anchor and Solana CLIs are not prerequisites for the core tests or SBF VM suite. They remain separate tools for standalone validator and deployment checks. The build tool's automatically generated `target/deploy/field_escrow-keypair.json` is not the configured program identity. Do not deploy with it. A deployment must explicitly use the key whose public address matches the program bound into tasks.

## Binding and settlement

The escrow address is derived from `escrow`, the requester wallet and the 16 task ID bytes. Task identity onchain is therefore scoped to a requester. This prevents another signer from preempting a requester task by initializing its ID. The backend must still enforce globally unique task IDs. Terminal accounts are retained and cannot be funded again for the same requester and ID.

An unsolicited SOL transfer to the derived address does not give its sender task authority. Funding tops up account rent as needed. Settlement moves exactly the stored task price, not the entire balance. The account rent reserve and unsolicited surplus remain in the terminal account and are not a fee or part of the reward. This demo has no cleanup or surplus withdrawal instruction.

The report hash establishes commitment, not report truth. There is no transfer before requester acceptance, reviewer resolution or the agreed refund condition. All financial deadlines use the Solana program clock. Client-reported observation times are executor assertions and must not be presented as chain-verified timestamps.

The program stores an opaque task commitment alongside financial terms. It cannot prove that the task preimage matches those terms. A client must reconstruct the instruction from the approved canonical task and compare the complete transaction before signing. Verify the finalized account fields against that same task before showing business outcomes. Verify a retrieved report against the recorded report hash before offering acceptance. Instruction builders alone are not this complete signing flow.

An upgradeable deployment can change these rules. For a disposable closed demo, retain and disclose the deployment authority while testing. It is not independent, immutable custody. A production deployment needs a separately agreed upgrade-authority policy. Changes to program identity invalidate existing quotes.

## Recovery boundary

A funded task cannot use the memo experiment's local abandonment escape. Missing RPC data is not a refund or permission to fund again. A lost transaction response requires reconciliation of the same task and pending operation. Paid and refunded are terminal. A recreated agent session may read the result but must not create another task automatically.
