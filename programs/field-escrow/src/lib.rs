use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

pub mod rules;

pub use rules::{Escrow, EscrowError, FundTerms, State};

declare_id!("8nxj7c8hn9hhqBE6GrBeNLNEiBJrUHhyFo6wmuxmc7hr");

#[program]
pub mod field_escrow {
    use super::*;

    pub fn fund(ctx: Context<Fund>, terms: FundTerms) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let escrow = Escrow::funded(terms, ctx.accounts.requester.key(), now, ctx.bumps.escrow)?;
        require!(
            ctx.accounts.escrow.key() != escrow.executor
                && ctx.accounts.escrow.key() != escrow.reviewer,
            EscrowError::InvalidRoles
        );
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.requester.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            escrow.price_lamports,
        )?;
        ctx.accounts.escrow.set_inner(escrow);
        Ok(())
    }

    pub fn submit_report(ctx: Context<SubmitReport>, report_hash: [u8; 32]) -> Result<()> {
        ctx.accounts.escrow.submit_report(
            ctx.accounts.executor.key(),
            report_hash,
            Clock::get()?.unix_timestamp,
        )
    }

    pub fn accept_and_release(ctx: Context<Accept>, report_hash: [u8; 32]) -> Result<()> {
        ctx.accounts.escrow.accept(
            ctx.accounts.requester.key(),
            report_hash,
            Clock::get()?.unix_timestamp,
        )?;
        settle(
            &ctx.accounts.escrow,
            &ctx.accounts.executor.to_account_info(),
        )
    }

    pub fn open_dispute(ctx: Context<OpenDispute>) -> Result<()> {
        ctx.accounts
            .escrow
            .open_dispute(ctx.accounts.authority.key(), Clock::get()?.unix_timestamp)
    }

    pub fn resolve(ctx: Context<Resolve>, pay_executor: bool) -> Result<()> {
        ctx.accounts.escrow.resolve(
            ctx.accounts.reviewer.key(),
            pay_executor,
            Clock::get()?.unix_timestamp,
        )?;
        let recipient = if pay_executor {
            ctx.accounts.executor.to_account_info()
        } else {
            ctx.accounts.requester.to_account_info()
        };
        settle(&ctx.accounts.escrow, &recipient)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        ctx.accounts
            .escrow
            .refund(ctx.accounts.requester.key(), Clock::get()?.unix_timestamp)?;
        settle(
            &ctx.accounts.escrow,
            &ctx.accounts.requester.to_account_info(),
        )
    }
}

fn settle(escrow: &Account<Escrow>, recipient: &AccountInfo) -> Result<()> {
    let account = escrow.to_account_info();
    let reserve = Rent::get()?.minimum_balance(account.data_len());
    let remaining = account
        .lamports()
        .checked_sub(escrow.price_lamports)
        .ok_or(EscrowError::InsufficientEscrow)?;
    require!(remaining >= reserve, EscrowError::InsufficientEscrow);
    require!(account.key() != recipient.key(), EscrowError::InvalidRoles);
    let credited = recipient
        .lamports()
        .checked_add(escrow.price_lamports)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    **account.try_borrow_mut_lamports()? = remaining;
    **recipient.try_borrow_mut_lamports()? = credited;
    Ok(())
}

#[derive(Accounts)]
#[instruction(terms: FundTerms)]
pub struct Fund<'info> {
    #[account(init, payer = requester, space = 8 + Escrow::INIT_SPACE,
        seeds = [b"escrow", requester.key().as_ref(), terms.task_id.as_ref()], bump)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, owner = system_program::ID)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitReport<'info> {
    #[account(mut, seeds = [b"escrow", escrow.requester.as_ref(), escrow.task_id.as_ref()], bump = escrow.bump,
        has_one = executor @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(mut, seeds = [b"escrow", escrow.requester.as_ref(), escrow.task_id.as_ref()], bump = escrow.bump,
        has_one = requester @ EscrowError::Unauthorized, has_one = executor @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    pub requester: Signer<'info>,
    #[account(mut)]
    pub executor: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenDispute<'info> {
    #[account(mut, seeds = [b"escrow", escrow.requester.as_ref(), escrow.task_id.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut, seeds = [b"escrow", escrow.requester.as_ref(), escrow.task_id.as_ref()], bump = escrow.bump,
        has_one = reviewer @ EscrowError::Unauthorized, has_one = requester @ EscrowError::Unauthorized,
        has_one = executor @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    pub reviewer: Signer<'info>,
    #[account(mut)]
    pub requester: SystemAccount<'info>,
    #[account(mut)]
    pub executor: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [b"escrow", escrow.requester.as_ref(), escrow.task_id.as_ref()], bump = escrow.bump,
        has_one = requester @ EscrowError::Unauthorized)]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, owner = system_program::ID)]
    pub requester: Signer<'info>,
}
