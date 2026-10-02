import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { ComputeBudgetInstruction, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { SolanaSignTransactionInput } from '@solana/wallet-standard-features';
import { adaptPhantomWallet, DEVNET_CHAIN } from './provider';
import { encodeMessage, makeTransaction } from './rpc';

const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const publicKey = signer.publicKey;
const blockhash = new PublicKey(new Uint8Array(32).fill(8)).toBase58();

function standardWallet(chains: Wallet['chains'] = ['solana:mainnet', DEVNET_CHAIN]) {
  const account: WalletAccount = { address: publicKey.toBase58(), publicKey: publicKey.toBytes(), chains, features: ['solana:signTransaction'] };
  let accounts: readonly WalletAccount[] = [];
  let input: SolanaSignTransactionInput | undefined;
  let calls = 0;
  const wallet: Wallet = {
    version: '1.0.0', name: 'Phantom', icon: 'data:image/svg+xml;base64,', chains,
    get accounts() { return accounts; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; return { accounts }; } },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signTransaction: async (request: SolanaSignTransactionInput) => {
          input = request; calls += 1;
          const transaction = Transaction.from(Buffer.from(request.transaction));
          transaction.sign(signer);
          return [{ signedTransaction: transaction.serialize() }];
        },
      },
    },
  };
  return { wallet, get input() { return input; }, get calls() { return calls; }, setAccounts: (next: readonly WalletAccount[]) => { accounts = next; } };
}

test('Wallet Standard signs with explicit devnet and returns full signed bytes', async () => {
  const fake = standardWallet();
  const provider = adaptPhantomWallet(fake.wallet)!;
  assert.equal(provider.publicKey, null);
  assert.equal((await provider.connect()).publicKey.toBase58(), publicKey.toBase58());
  const transaction = makeTransaction(publicKey.toBase58(), blockhash, crypto.randomUUID());
  const result = await provider.signTransaction(transaction);
  assert.equal(fake.input?.chain, DEVNET_CHAIN);
  assert.equal(fake.input?.account, fake.wallet.accounts[0]);
  assert.equal(encodeMessage(Transaction.from(Buffer.from(fake.input!.transaction))), encodeMessage(transaction));
  assert.equal(encodeMessage(result), encodeMessage(transaction));
  assert.equal(result.verifySignatures(), true);
  assert.equal(fake.calls, 1);
});

test('mainnet-only wallet cannot connect for the check', async () => {
  const fake = standardWallet(['solana:mainnet']);
  const provider = adaptPhantomWallet(fake.wallet)!;
  await assert.rejects(provider.connect(), /Solana devnet/);
  assert.equal(fake.calls, 0);
});

test('account without devnet support cannot be signed', async () => {
  const fake = standardWallet();
  const provider = adaptPhantomWallet(fake.wallet)!;
  await provider.connect();
  fake.setAccounts([{ ...fake.wallet.accounts[0]!, chains: ['solana:mainnet'] }]);
  assert.equal(provider.publicKey, null);
  await assert.rejects(provider.signTransaction(makeTransaction(publicKey.toBase58(), blockhash, crypto.randomUUID())), /Testnet Mode/);
  assert.equal(fake.calls, 0);
});

test('legacy-only wallet is not a fallback for explicit-chain signing', () => {
  const fake = standardWallet();
  assert.equal(adaptPhantomWallet({ ...fake.wallet, features: { 'standard:connect': fake.wallet.features['standard:connect'] } }), null);
});

test('send-only wallet cannot fall back to opaque wallet submission', () => {
  const fake = standardWallet();
  assert.equal(adaptPhantomWallet({ ...fake.wallet, features: {
    'standard:connect': fake.wallet.features['standard:connect'],
    'solana:signAndSendTransaction': { version: '1.0.0' },
  } }), null);
});

test('changed fee payer blocks the wallet request', async () => {
  const fake = standardWallet();
  const provider = adaptPhantomWallet(fake.wallet)!;
  await provider.connect();
  const changed = new PublicKey(new Uint8Array(32).fill(9));
  await assert.rejects(provider.signTransaction(makeTransaction(changed.toBase58(), blockhash, crypto.randomUUID())), /Кошелёк изменился/);
  assert.equal(fake.calls, 0);
});

test('memo check has explicit zero priority price and bounded compute limit', () => {
  const transaction = makeTransaction(publicKey.toBase58(), blockhash, crypto.randomUUID());
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(transaction.instructions[1]!).microLamports, 0n);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(transaction.instructions[0]!).units, 200_000);
});
