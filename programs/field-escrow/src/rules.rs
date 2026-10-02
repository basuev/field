use anchor_lang::prelude::*;
use solana_curve25519::edwards::{validate_edwards, PodEdwardsPoint};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct FundTerms {
    pub task_id: [u8; 16],
    pub task_hash: [u8; 32],
    pub executor: Pubkey,
    pub reviewer: Pubkey,
    pub price_lamports: u64,
    pub quote_expiry: i64,
    pub execution_deadline: i64,
    pub review_deadline: i64,
    pub resolution_deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum State {
    Funded,
    Submitted,
    Disputed,
    Paid,
    Refunded,
}

#[account]
#[derive(InitSpace, Debug)]
pub struct Escrow {
    pub version: u8,
    pub task_id: [u8; 16],
    pub task_hash: [u8; 32],
    pub requester: Pubkey,
    pub executor: Pubkey,
    pub reviewer: Pubkey,
    pub price_lamports: u64,
    pub quote_expiry: i64,
    pub execution_deadline: i64,
    pub review_deadline: i64,
    pub resolution_deadline: i64,
    pub funded_at: i64,
    pub report_hash: [u8; 32],
    pub state: State,
    pub bump: u8,
}

impl Escrow {
    pub fn funded(terms: FundTerms, requester: Pubkey, now: i64, bump: u8) -> Result<Self> {
        require!(
            now >= 0
                && now < terms.quote_expiry
                && terms.quote_expiry <= terms.execution_deadline
                && terms.execution_deadline < terms.review_deadline
                && terms.review_deadline < terms.resolution_deadline,
            EscrowError::InvalidDeadlines
        );
        require!(terms.price_lamports > 0, EscrowError::InvalidPrice);
        require!(
            terms.task_id != [0; 16] && terms.task_hash != [0; 32],
            EscrowError::InvalidCommitment
        );
        require!(
            requester != terms.executor
                && requester != terms.reviewer
                && terms.executor != terms.reviewer
                && signing_key(&requester)
                && signing_key(&terms.executor)
                && signing_key(&terms.reviewer),
            EscrowError::InvalidRoles
        );
        Ok(Self {
            version: 1,
            task_id: terms.task_id,
            task_hash: terms.task_hash,
            requester,
            executor: terms.executor,
            reviewer: terms.reviewer,
            price_lamports: terms.price_lamports,
            quote_expiry: terms.quote_expiry,
            execution_deadline: terms.execution_deadline,
            review_deadline: terms.review_deadline,
            resolution_deadline: terms.resolution_deadline,
            funded_at: now,
            report_hash: [0; 32],
            state: State::Funded,
            bump,
        })
    }

    pub fn submit_report(&mut self, actor: Pubkey, hash: [u8; 32], now: i64) -> Result<()> {
        require_keys_eq!(actor, self.executor, EscrowError::Unauthorized);
        require!(self.state == State::Funded, EscrowError::InvalidState);
        require!(
            now >= self.funded_at && now < self.execution_deadline,
            EscrowError::Deadline
        );
        require!(hash != [0; 32], EscrowError::InvalidCommitment);
        self.report_hash = hash;
        self.state = State::Submitted;
        Ok(())
    }

    pub fn accept(&mut self, actor: Pubkey, expected_hash: [u8; 32], now: i64) -> Result<()> {
        require_keys_eq!(actor, self.requester, EscrowError::Unauthorized);
        require!(self.state == State::Submitted, EscrowError::InvalidState);
        require!(
            now >= self.funded_at && now < self.review_deadline,
            EscrowError::Deadline
        );
        require!(
            expected_hash == self.report_hash,
            EscrowError::InvalidCommitment
        );
        self.state = State::Paid;
        Ok(())
    }

    pub fn open_dispute(&mut self, actor: Pubkey, now: i64) -> Result<()> {
        require!(
            actor == self.requester || actor == self.executor,
            EscrowError::Unauthorized
        );
        require!(self.state == State::Submitted, EscrowError::InvalidState);
        require!(
            now >= self.funded_at && now < self.resolution_deadline,
            EscrowError::Deadline
        );
        require!(
            actor == self.requester || now >= self.review_deadline,
            EscrowError::Deadline
        );
        self.state = State::Disputed;
        Ok(())
    }

    pub fn resolve(&mut self, actor: Pubkey, pay_executor: bool, now: i64) -> Result<()> {
        require_keys_eq!(actor, self.reviewer, EscrowError::Unauthorized);
        require!(self.state == State::Disputed, EscrowError::InvalidState);
        require!(
            now >= self.funded_at && now < self.resolution_deadline,
            EscrowError::Deadline
        );
        self.state = if pay_executor {
            State::Paid
        } else {
            State::Refunded
        };
        Ok(())
    }

    pub fn refund(&mut self, actor: Pubkey, now: i64) -> Result<()> {
        require_keys_eq!(actor, self.requester, EscrowError::Unauthorized);
        let active = matches!(
            self.state,
            State::Funded | State::Submitted | State::Disputed
        );
        require!(active, EscrowError::InvalidState);
        require!(
            now >= self.resolution_deadline
                || (self.state == State::Funded && now >= self.execution_deadline),
            EscrowError::Deadline
        );
        self.state = State::Refunded;
        Ok(())
    }
}

fn signing_key(key: &Pubkey) -> bool {
    validate_edwards(&PodEdwardsPoint(key.to_bytes()))
}

#[error_code]
pub enum EscrowError {
    #[msg("The signer or recipient is not the fixed task authority")]
    Unauthorized,
    #[msg("The escrow state does not permit this operation")]
    InvalidState,
    #[msg("The operation is outside its absolute deadline")]
    Deadline,
    #[msg("Funding terms contain invalid deadlines")]
    InvalidDeadlines,
    #[msg("Task price must be positive")]
    InvalidPrice,
    #[msg("Commitment is empty or does not match")]
    InvalidCommitment,
    #[msg("Requester, executor and reviewer require distinct signing wallets")]
    InvalidRoles,
    #[msg("Escrow cannot pay the task price and retain its rent reserve")]
    InsufficientEscrow,
    #[msg("Lamport arithmetic overflow")]
    ArithmeticOverflow,
}
