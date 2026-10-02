#![forbid(unsafe_code)]

use anchor_lang::{
    prelude::{Clock, Pubkey, Rent},
    AccountDeserialize, InstructionData, Space, ToAccountMetas,
};
use field_escrow::{accounts, instruction, Escrow, EscrowError, FundTerms, State};
use solana_program_test::{BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::{Account, AccountSharedData},
    compute_budget::ComputeBudgetInstruction,
    instruction::{Instruction, InstructionError},
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};

fn denied(result: Result<(), BanksClientError>, expected: EscrowError) {
    match result.unwrap_err() {
        BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            InstructionError::Custom(code),
        )) => assert_eq!(code, u32::from(expected)),
        other => panic!("Unexpected rejection {other:?}"),
    }
}

struct Harness {
    context: ProgramTestContext,
    requester: Keypair,
    executor: Keypair,
    reviewer: Keypair,
    outsider: Keypair,
    escrow: Pubkey,
    terms: FundTerms,
    nonce: u64,
}

impl Harness {
    async fn start(prefund: u64) -> Self {
        let requester = Keypair::new();
        let executor = Keypair::new();
        let reviewer = Keypair::new();
        let outsider = Keypair::new();
        let terms = FundTerms {
            task_id: [1; 16],
            task_hash: [2; 32],
            executor: executor.pubkey(),
            reviewer: reviewer.pubkey(),
            price_lamports: 1_000_000,
            quote_expiry: 200,
            execution_deadline: 300,
            review_deadline: 400,
            resolution_deadline: 500,
        };
        let escrow = Pubkey::find_program_address(
            &[b"escrow", requester.pubkey().as_ref(), &terms.task_id],
            &field_escrow::ID,
        )
        .0;
        let artifact = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy/field_escrow.so");
        let data =
            std::fs::read(artifact).expect("Build the escrow SBF artifact before running VM tests");
        assert_eq!(&data[..4], b"\x7fELF");
        let mut program = ProgramTest::default();
        program.add_account(
            field_escrow::ID,
            Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: solana_sdk::bpf_loader::ID,
                executable: true,
                rent_epoch: 0,
            },
        );
        for wallet in [&requester, &executor, &reviewer, &outsider] {
            program.add_account(
                wallet.pubkey(),
                Account {
                    lamports: 10_000_000_000,
                    data: vec![],
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            );
        }
        if prefund > 0 {
            program.add_account(
                escrow,
                Account {
                    lamports: prefund,
                    data: vec![],
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            );
        }
        let context = program.start_with_context().await;
        context.set_sysvar(&Clock {
            unix_timestamp: 100,
            ..Clock::default()
        });
        Self {
            context,
            requester,
            executor,
            reviewer,
            outsider,
            escrow,
            terms,
            nonce: 0,
        }
    }

    fn ix(&self, keys: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
        Instruction {
            program_id: field_escrow::ID,
            accounts: keys.to_account_metas(None),
            data: data.data(),
        }
    }

    async fn execute(&mut self, ix: Instruction, actor: &Keypair) -> Result<(), BanksClientError> {
        self.nonce += 1;
        let tx = Transaction::new_signed_with_payer(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(200_000),
                ComputeBudgetInstruction::set_compute_unit_price(self.nonce),
                ix,
            ],
            Some(&self.context.payer.pubkey()),
            &[&self.context.payer, actor],
            self.context.last_blockhash,
        );
        self.context.banks_client.process_transaction(tx).await
    }

    async fn fund(&mut self) -> Result<(), BanksClientError> {
        let ix = self.ix(
            accounts::Fund {
                escrow: self.escrow,
                requester: self.requester.pubkey(),
                system_program: solana_sdk::system_program::ID,
            },
            instruction::Fund {
                terms: self.terms.clone(),
            },
        );
        let signer = self.requester.insecure_clone();
        self.execute(ix, &signer).await
    }

    async fn submit(&mut self) -> Result<(), BanksClientError> {
        let ix = self.ix(
            accounts::SubmitReport {
                escrow: self.escrow,
                executor: self.executor.pubkey(),
            },
            instruction::SubmitReport {
                report_hash: [3; 32],
            },
        );
        let signer = self.executor.insecure_clone();
        self.execute(ix, &signer).await
    }

    fn accept_ix(&self) -> Instruction {
        self.ix(
            accounts::Accept {
                escrow: self.escrow,
                requester: self.requester.pubkey(),
                executor: self.executor.pubkey(),
            },
            instruction::AcceptAndRelease {
                report_hash: [3; 32],
            },
        )
    }

    fn refund_ix(&self) -> Instruction {
        self.ix(
            accounts::Refund {
                escrow: self.escrow,
                requester: self.requester.pubkey(),
            },
            instruction::Refund {},
        )
    }

    async fn account(&mut self) -> Account {
        self.context
            .banks_client
            .get_account(self.escrow)
            .await
            .unwrap()
            .unwrap()
    }
    async fn state(&mut self) -> Escrow {
        Escrow::try_deserialize(&mut self.account().await.data.as_slice()).unwrap()
    }
    async fn balance(&mut self, address: Pubkey) -> u64 {
        self.context
            .banks_client
            .get_balance(address)
            .await
            .unwrap()
    }
    fn time(&self, now: i64) {
        self.context.set_sysvar(&Clock {
            unix_timestamp: now,
            ..Clock::default()
        });
    }
}

#[tokio::test]
async fn invalid_funding_terms_roll_back_account_creation_and_requester_balance() {
    for case in 0..4 {
        let mut h = Harness::start(0).await;
        let requester = h.requester.pubkey();
        let before = h.balance(requester).await;
        let expected = match case {
            0 => {
                h.terms.task_hash = [0; 32];
                EscrowError::InvalidCommitment
            }
            1 => {
                h.terms.price_lamports = 0;
                EscrowError::InvalidPrice
            }
            2 => {
                h.terms.reviewer = h.escrow;
                EscrowError::InvalidRoles
            }
            _ => {
                h.time(h.terms.quote_expiry);
                EscrowError::InvalidDeadlines
            }
        };
        denied(h.fund().await, expected);
        assert!(h
            .context
            .banks_client
            .get_account(h.escrow)
            .await
            .unwrap()
            .is_none());
        assert_eq!(h.balance(requester).await, before);
    }
}

#[tokio::test]
async fn funding_submission_acceptance_pay_exact_price_and_retain_terminal_account() {
    let mut h = Harness::start(0).await;
    let requester_before = h.balance(h.requester.pubkey()).await;
    let executor_before = h.balance(h.executor.pubkey()).await;
    h.fund().await.unwrap();
    let funded = h.account().await;
    let rent = Rent::default().minimum_balance(funded.data.len());
    assert_eq!(funded.lamports, rent + h.terms.price_lamports);
    assert_eq!(
        h.balance(h.requester.pubkey()).await,
        requester_before - funded.lamports
    );
    h.submit().await.unwrap();
    let requester = h.requester.insecure_clone();
    let ix = h.accept_ix();
    h.execute(ix.clone(), &requester).await.unwrap();
    assert_eq!(h.state().await.state, State::Paid);
    assert_eq!(
        h.balance(h.executor.pubkey()).await,
        executor_before + h.terms.price_lamports
    );
    assert_eq!(h.account().await.lamports, rent);
    denied(h.execute(ix, &requester).await, EscrowError::InvalidState);
    assert!(h.fund().await.is_err());
    assert_eq!(h.account().await.lamports, rent);
}

#[tokio::test]
async fn wrong_signers_recipients_and_report_hashes_cannot_move_escrow_funds() {
    let mut h = Harness::start(0).await;
    h.fund().await.unwrap();
    let bad_submit = h.ix(
        accounts::SubmitReport {
            escrow: h.escrow,
            executor: h.outsider.pubkey(),
        },
        instruction::SubmitReport {
            report_hash: [3; 32],
        },
    );
    let outsider = h.outsider.insecure_clone();
    denied(
        h.execute(bad_submit, &outsider).await,
        EscrowError::Unauthorized,
    );
    h.submit().await.unwrap();
    let before = h.account().await;
    let requester = h.requester.insecure_clone();
    for (authority, recipient, hash, error) in [
        (
            h.requester.pubkey(),
            h.outsider.pubkey(),
            [3; 32],
            EscrowError::Unauthorized,
        ),
        (
            h.requester.pubkey(),
            h.executor.pubkey(),
            [4; 32],
            EscrowError::InvalidCommitment,
        ),
        (
            h.outsider.pubkey(),
            h.executor.pubkey(),
            [3; 32],
            EscrowError::Unauthorized,
        ),
    ] {
        let ix = h.ix(
            accounts::Accept {
                escrow: h.escrow,
                requester: authority,
                executor: recipient,
            },
            instruction::AcceptAndRelease { report_hash: hash },
        );
        let actor = if authority == h.requester.pubkey() {
            &requester
        } else {
            &outsider
        };
        denied(h.execute(ix, actor).await, error);
        assert_eq!(h.account().await, before);
    }
}

#[tokio::test]
async fn prefunding_and_donations_never_increase_reward_or_refund() {
    let rent = Rent::default().minimum_balance(8 + Escrow::INIT_SPACE);
    for prefund in [1_000_000, rent, rent + 1_000_000] {
        for pay in [true, false] {
            let mut h = Harness::start(prefund).await;
            let requester_before = h.balance(h.requester.pubkey()).await;
            let executor_before = h.balance(h.executor.pubkey()).await;
            h.fund().await.unwrap();
            assert_eq!(
                h.account().await.lamports,
                rent.max(prefund) + h.terms.price_lamports
            );
            assert_eq!(
                h.balance(h.requester.pubkey()).await,
                requester_before - h.terms.price_lamports - rent.saturating_sub(prefund)
            );
            let donation = 777;
            let transfer =
                solana_sdk::system_instruction::transfer(&h.outsider.pubkey(), &h.escrow, donation);
            let outsider = h.outsider.insecure_clone();
            h.execute(transfer, &outsider).await.unwrap();
            let requester = h.requester.insecure_clone();
            if pay {
                h.submit().await.unwrap();
                let ix = h.accept_ix();
                h.execute(ix, &requester).await.unwrap();
                assert_eq!(
                    h.balance(h.executor.pubkey()).await,
                    executor_before + h.terms.price_lamports
                );
            } else {
                h.time(300);
                let before = h.balance(h.requester.pubkey()).await;
                let ix = h.refund_ix();
                h.execute(ix, &requester).await.unwrap();
                assert_eq!(
                    h.balance(h.requester.pubkey()).await,
                    before + h.terms.price_lamports
                );
                assert_eq!(h.balance(h.executor.pubkey()).await, executor_before);
            }
            assert_eq!(h.account().await.lamports, rent.max(prefund) + donation);
        }
    }
}

#[tokio::test]
async fn no_report_refund_uses_chain_clock_at_exact_execution_deadline() {
    let mut h = Harness::start(0).await;
    h.fund().await.unwrap();
    let requester_before = h.balance(h.requester.pubkey()).await;
    let ix = h.refund_ix();
    let requester = h.requester.insecure_clone();
    h.time(299);
    denied(
        h.execute(ix.clone(), &requester).await,
        EscrowError::Deadline,
    );
    h.time(300);
    h.execute(ix.clone(), &requester).await.unwrap();
    assert_eq!(
        h.balance(h.requester.pubkey()).await,
        requester_before + h.terms.price_lamports
    );
    assert_eq!(h.state().await.state, State::Refunded);
    denied(h.execute(ix, &requester).await, EscrowError::InvalidState);
    assert!(h.fund().await.is_err());
}

#[tokio::test]
async fn disputed_resolution_has_fixed_recipients_and_final_refund_wins_after_deadline() {
    for pay in [true, false] {
        let mut h = Harness::start(0).await;
        h.fund().await.unwrap();
        h.submit().await.unwrap();
        let dispute = h.ix(
            accounts::OpenDispute {
                escrow: h.escrow,
                authority: h.executor.pubkey(),
            },
            instruction::OpenDispute {},
        );
        let executor = h.executor.insecure_clone();
        h.time(399);
        denied(
            h.execute(dispute.clone(), &executor).await,
            EscrowError::Deadline,
        );
        h.time(400);
        h.execute(dispute, &executor).await.unwrap();
        let resolve = h.ix(
            accounts::Resolve {
                escrow: h.escrow,
                reviewer: h.reviewer.pubkey(),
                requester: h.requester.pubkey(),
                executor: h.executor.pubkey(),
            },
            instruction::Resolve { pay_executor: pay },
        );
        let reviewer = h.reviewer.insecure_clone();
        h.time(499);
        let recipient = if pay {
            h.executor.pubkey()
        } else {
            h.requester.pubkey()
        };
        let before = h.balance(recipient).await;
        h.execute(resolve, &reviewer).await.unwrap();
        assert_eq!(h.balance(recipient).await, before + h.terms.price_lamports);
        assert_eq!(
            h.state().await.state,
            if pay { State::Paid } else { State::Refunded }
        );
    }
    let mut h = Harness::start(0).await;
    h.fund().await.unwrap();
    h.submit().await.unwrap();
    let requester = h.requester.insecure_clone();
    let dispute = h.ix(
        accounts::OpenDispute {
            escrow: h.escrow,
            authority: h.requester.pubkey(),
        },
        instruction::OpenDispute {},
    );
    h.execute(dispute, &requester).await.unwrap();
    h.time(500);
    let resolve = h.ix(
        accounts::Resolve {
            escrow: h.escrow,
            reviewer: h.reviewer.pubkey(),
            requester: h.requester.pubkey(),
            executor: h.executor.pubkey(),
        },
        instruction::Resolve { pay_executor: true },
    );
    let reviewer = h.reviewer.insecure_clone();
    denied(h.execute(resolve, &reviewer).await, EscrowError::Deadline);
    let refund = h.refund_ix();
    h.execute(refund, &requester).await.unwrap();
    assert_eq!(h.state().await.state, State::Refunded);
}

#[tokio::test]
async fn reviewer_or_recipient_substitution_cannot_redirect_resolution() {
    let mut h = Harness::start(0).await;
    h.fund().await.unwrap();
    h.submit().await.unwrap();
    let requester = h.requester.insecure_clone();
    let dispute = h.ix(
        accounts::OpenDispute {
            escrow: h.escrow,
            authority: h.requester.pubkey(),
        },
        instruction::OpenDispute {},
    );
    h.execute(dispute, &requester).await.unwrap();
    let before = h.account().await;
    let reviewer = h.reviewer.insecure_clone();
    let outsider = h.outsider.insecure_clone();
    let requester_balance = h.balance(h.requester.pubkey()).await;
    let executor_balance = h.balance(h.executor.pubkey()).await;
    let outsider_balance = h.balance(h.outsider.pubkey()).await;
    for (reviewer_key, requester_key, executor_key, pay) in [
        (
            h.reviewer.pubkey(),
            h.requester.pubkey(),
            h.outsider.pubkey(),
            true,
        ),
        (
            h.reviewer.pubkey(),
            h.outsider.pubkey(),
            h.executor.pubkey(),
            false,
        ),
        (
            h.outsider.pubkey(),
            h.requester.pubkey(),
            h.executor.pubkey(),
            true,
        ),
    ] {
        let resolve = h.ix(
            accounts::Resolve {
                escrow: h.escrow,
                reviewer: reviewer_key,
                requester: requester_key,
                executor: executor_key,
            },
            instruction::Resolve { pay_executor: pay },
        );
        let signer = if reviewer_key == h.reviewer.pubkey() {
            &reviewer
        } else {
            &outsider
        };
        denied(h.execute(resolve, signer).await, EscrowError::Unauthorized);
        assert_eq!(h.account().await, before);
        assert_eq!(h.balance(h.requester.pubkey()).await, requester_balance);
        assert_eq!(h.balance(h.executor.pubkey()).await, executor_balance);
        assert_eq!(h.balance(h.outsider.pubkey()).await, outsider_balance);
    }
}

#[tokio::test]
async fn payment_failure_rolls_back_terminal_state_and_recipient_balance() {
    let mut h = Harness::start(0).await;
    h.fund().await.unwrap();
    h.submit().await.unwrap();
    let mut damaged = h.account().await;
    damaged.lamports =
        Rent::default().minimum_balance(damaged.data.len()) + h.terms.price_lamports - 1;
    h.context
        .set_account(&h.escrow, &AccountSharedData::from(damaged.clone()));
    let before = h.balance(h.executor.pubkey()).await;
    let requester = h.requester.insecure_clone();
    let accept = h.accept_ix();
    denied(
        h.execute(accept, &requester).await,
        EscrowError::InsufficientEscrow,
    );
    assert_eq!(h.account().await, damaged);
    assert_eq!(h.balance(h.executor.pubkey()).await, before);
    assert_eq!(h.state().await.state, State::Submitted);
}
