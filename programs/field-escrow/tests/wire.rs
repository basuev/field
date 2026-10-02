use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use field_escrow::{accounts, instruction, Escrow, FundTerms};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn bytes(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn key(value: &Value) -> Pubkey {
    value.as_str().unwrap().parse().unwrap()
}

#[test]
fn rust_borsh_instructions_and_accounts_match_typescript_vectors() {
    let vector: Value =
        serde_json::from_str(include_str!("../../../fixtures/protocol-v1.json")).unwrap();
    let task = &vector["task"];
    let requester = key(&task["requester"]);
    let executor = key(&task["executor"]);
    let reviewer = key(&task["reviewer"]);
    let task_id: [u8; 16] = bytes(&task["id"].as_str().unwrap().replace('-', ""))
        .try_into()
        .unwrap();
    let task_hash: [u8; 32] = bytes(vector["taskHash"].as_str().unwrap())
        .try_into()
        .unwrap();
    let report_hash: [u8; 32] = bytes(vector["reportHash"].as_str().unwrap())
        .try_into()
        .unwrap();
    assert_eq!(
        hex(&Sha256::digest(bytes(
            vector["taskBytesHex"].as_str().unwrap()
        ))),
        vector["taskHash"].as_str().unwrap()
    );
    assert_eq!(
        hex(&Sha256::digest(bytes(
            vector["reportBytesHex"].as_str().unwrap()
        ))),
        vector["reportHash"].as_str().unwrap()
    );
    let (escrow, bump) = Pubkey::find_program_address(
        &[b"escrow", requester.as_ref(), &task_id],
        &field_escrow::ID,
    );
    assert_eq!(
        escrow.to_string(),
        vector["escrowAddress"].as_str().unwrap()
    );
    assert_eq!(
        field_escrow::ID.to_string(),
        task["escrowProgram"].as_str().unwrap()
    );
    let terms = FundTerms {
        task_id,
        task_hash,
        executor,
        reviewer,
        price_lamports: task["priceLamports"].as_str().unwrap().parse().unwrap(),
        quote_expiry: task["quoteExpiry"].as_i64().unwrap(),
        execution_deadline: task["executionDeadline"].as_i64().unwrap(),
        review_deadline: task["reviewDeadline"].as_i64().unwrap(),
        resolution_deadline: task["resolutionDeadline"].as_i64().unwrap(),
    };
    let funded = Escrow::funded(
        terms.clone(),
        requester,
        task["issuedAt"].as_i64().unwrap() + 1,
        bump,
    )
    .unwrap();
    let mut serialized = Vec::new();
    funded.try_serialize(&mut serialized).unwrap();
    assert_eq!(serialized.len(), 8 + Escrow::INIT_SPACE);
    assert_eq!(
        hex(&serialized),
        vector["fundedAccountHex"].as_str().unwrap()
    );
    let cases = [
        (
            "fund",
            instruction::Fund { terms }.data(),
            accounts::Fund {
                escrow,
                requester,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        ),
        (
            "submit_report",
            instruction::SubmitReport { report_hash }.data(),
            accounts::SubmitReport { escrow, executor }.to_account_metas(None),
        ),
        (
            "accept_and_release",
            instruction::AcceptAndRelease { report_hash }.data(),
            accounts::Accept {
                escrow,
                requester,
                executor,
            }
            .to_account_metas(None),
        ),
        (
            "open_dispute",
            instruction::OpenDispute {}.data(),
            accounts::OpenDispute {
                escrow,
                authority: requester,
            }
            .to_account_metas(None),
        ),
        (
            "resolve_paid",
            instruction::Resolve { pay_executor: true }.data(),
            accounts::Resolve {
                escrow,
                reviewer,
                requester,
                executor,
            }
            .to_account_metas(None),
        ),
        (
            "resolve_refunded",
            instruction::Resolve {
                pay_executor: false,
            }
            .data(),
            accounts::Resolve {
                escrow,
                reviewer,
                requester,
                executor,
            }
            .to_account_metas(None),
        ),
        (
            "refund",
            instruction::Refund {}.data(),
            accounts::Refund { escrow, requester }.to_account_metas(None),
        ),
    ];
    for (name, data, accounts) in cases {
        let expected = &vector["instructions"][name];
        assert_eq!(hex(&data), expected["dataHex"].as_str().unwrap(), "{name}");
        let keys: Vec<Value> = accounts.iter().map(|account| serde_json::json!({ "address": account.pubkey.to_string(), "signer": account.is_signer, "writable": account.is_writable })).collect();
        assert_eq!(
            keys,
            expected["accounts"].as_array().unwrap().clone(),
            "{name}"
        );
    }
}
