use anchor_lang::prelude::*;
use field_escrow::{Escrow, FundTerms, State};

fn wallet() -> Pubkey {
    loop {
        let key = Pubkey::new_unique();
        if key.is_on_curve() {
            return key;
        }
    }
}

fn fixture() -> Escrow {
    let requester = wallet();
    Escrow::funded(
        FundTerms {
            task_id: [1; 16],
            task_hash: [2; 32],
            executor: wallet(),
            reviewer: wallet(),
            price_lamports: 1_000_000,
            quote_expiry: 200,
            execution_deadline: 300,
            review_deadline: 400,
            resolution_deadline: 500,
        },
        requester,
        100,
        255,
    )
    .unwrap()
}

fn assert_denied(escrow: &mut Escrow, operation: impl FnOnce(&mut Escrow) -> Result<()>) {
    let before = escrow.try_to_vec().unwrap();
    assert!(operation(escrow).is_err());
    assert_eq!(escrow.try_to_vec().unwrap(), before);
}

#[test]
fn funding_rejects_bad_terms_at_exact_expiry() {
    let valid = fixture();
    let terms = FundTerms {
        task_id: valid.task_id,
        task_hash: valid.task_hash,
        executor: valid.executor,
        reviewer: valid.reviewer,
        price_lamports: valid.price_lamports,
        quote_expiry: 200,
        execution_deadline: 300,
        review_deadline: 400,
        resolution_deadline: 500,
    };
    assert!(Escrow::funded(terms.clone(), valid.requester, 199, 1).is_ok());
    assert!(Escrow::funded(terms.clone(), valid.requester, 200, 1).is_err());
    let mut bad = terms.clone();
    bad.review_deadline = bad.execution_deadline;
    assert!(Escrow::funded(bad, valid.requester, 100, 1).is_err());
    let mut bad = terms.clone();
    bad.executor = valid.requester;
    assert!(Escrow::funded(bad, valid.requester, 100, 1).is_err());
    let mut bad = terms.clone();
    bad.price_lamports = 0;
    assert!(Escrow::funded(bad, valid.requester, 100, 1).is_err());
    let mut bad = terms.clone();
    bad.reviewer = Pubkey::find_program_address(&[b"not-a-signing-wallet"], &field_escrow::ID).0;
    assert!(Escrow::funded(bad, valid.requester, 100, 1).is_err());
    let mut bad = terms;
    bad.task_hash = [0; 32];
    assert!(Escrow::funded(bad, valid.requester, 100, 1).is_err());
}

#[test]
fn report_is_executor_only_immutable_and_before_execution_deadline() {
    let mut escrow = fixture();
    let worker = escrow.executor;
    assert_denied(&mut escrow, |e| e.submit_report(e.requester, [3; 32], 200));
    assert_denied(&mut escrow, |e| e.submit_report(worker, [0; 32], 200));
    assert_denied(&mut escrow, |e| e.submit_report(worker, [3; 32], 300));
    escrow.submit_report(worker, [3; 32], 299).unwrap();
    assert_eq!(escrow.state, State::Submitted);
    assert_denied(&mut escrow, |e| e.submit_report(worker, [4; 32], 299));
    assert_eq!(escrow.report_hash, [3; 32]);
}

#[test]
fn acceptance_requires_requester_exact_hash_and_pre_review_deadline() {
    let mut escrow = fixture();
    escrow.submit_report(escrow.executor, [3; 32], 200).unwrap();
    assert_denied(&mut escrow, |e| e.accept(e.executor, [3; 32], 250));
    assert_denied(&mut escrow, |e| e.accept(e.requester, [4; 32], 250));
    assert_denied(&mut escrow, |e| e.accept(e.requester, [3; 32], 400));
    escrow.accept(escrow.requester, [3; 32], 399).unwrap();
    assert_eq!(escrow.state, State::Paid);
}

#[test]
fn no_report_refund_has_no_early_cancellation() {
    let mut escrow = fixture();
    assert_denied(&mut escrow, |e| e.refund(e.requester, 299));
    assert_denied(&mut escrow, |e| e.refund(e.executor, 300));
    escrow.refund(escrow.requester, 300).unwrap();
    assert_eq!(escrow.state, State::Refunded);
}

#[test]
fn dispute_authority_changes_at_review_deadline_and_ends_at_final_deadline() {
    for now in [399, 400, 499, 500] {
        for requester in [true, false] {
            let mut escrow = fixture();
            escrow.submit_report(escrow.executor, [3; 32], 200).unwrap();
            let actor = if requester {
                escrow.requester
            } else {
                escrow.executor
            };
            let allowed = now < 500 && (requester || now >= 400);
            assert_eq!(escrow.open_dispute(actor, now).is_ok(), allowed);
        }
    }
}

#[test]
fn dispute_locks_acceptance_and_reviewer_has_only_two_outcomes() {
    for pay in [true, false] {
        let mut escrow = fixture();
        escrow.submit_report(escrow.executor, [3; 32], 200).unwrap();
        escrow.open_dispute(escrow.requester, 250).unwrap();
        assert_denied(&mut escrow, |e| e.accept(e.requester, [3; 32], 260));
        assert_denied(&mut escrow, |e| e.resolve(e.requester, pay, 260));
        assert_denied(&mut escrow, |e| e.resolve(e.reviewer, pay, 500));
        escrow.resolve(escrow.reviewer, pay, 499).unwrap();
        assert_eq!(
            escrow.state,
            if pay { State::Paid } else { State::Refunded }
        );
    }
}

#[test]
fn final_refund_applies_to_every_active_state() {
    for state in [State::Funded, State::Submitted, State::Disputed] {
        let mut escrow = fixture();
        escrow.state = state;
        if state != State::Funded {
            assert_denied(&mut escrow, |e| e.refund(e.requester, 499));
        }
        escrow.refund(escrow.requester, 500).unwrap();
        assert_eq!(escrow.state, State::Refunded);
    }
}

#[test]
fn paid_and_refunded_are_irreversible() {
    for state in [State::Paid, State::Refunded] {
        let mut escrow = fixture();
        escrow.state = state;
        assert_denied(&mut escrow, |e| e.submit_report(e.executor, [3; 32], 200));
        assert_denied(&mut escrow, |e| e.accept(e.requester, [3; 32], 250));
        assert_denied(&mut escrow, |e| e.open_dispute(e.requester, 250));
        assert_denied(&mut escrow, |e| e.resolve(e.reviewer, true, 250));
        assert_denied(&mut escrow, |e| e.refund(e.requester, 500));
    }
}
