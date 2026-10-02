import { PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, StandardEvents, type StandardConnectFeature, type StandardEventsFeature } from '@wallet-standard/features';

export const DEVNET_CHAIN = 'solana:devnet';

export interface PhantomProvider {
  isPhantom: true;
  chain: typeof DEVNET_CHAIN;
  readonly publicKey: PublicKey | null;
  assertReady(): void;
  connect(): Promise<{ publicKey: PublicKey }>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  subscribe?(listener: () => void): () => void;
}

declare global {
  interface Window {
    phantom?: { solana?: { isPhantom?: boolean } };
  }
}

export function adaptPhantomWallet(wallet: Wallet): PhantomProvider | null {
  const features = wallet.features as Partial<StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature>;
  const connect = features[StandardConnect];
  const sign = features[SolanaSignTransaction];
  if (wallet.name !== 'Phantom' || connect?.version !== '1.0.0' || sign?.version !== '1.0.0'
    || typeof connect.connect !== 'function' || typeof sign.signTransaction !== 'function'
    || !sign.supportedTransactionVersions.includes('legacy')) return null;

  function currentAccount(): WalletAccount | undefined {
    return wallet.accounts.find(account => account.chains.includes(DEVNET_CHAIN)
      && account.features.includes(SolanaSignTransaction));
  }

  function assertReady(): void {
    const account = currentAccount();
    if (!wallet.chains.includes(DEVNET_CHAIN) || !account) {
      throw new Error('Кошелёк не разрешает Solana devnet. Включите Testnet Mode в настройках Phantom и подключитесь заново.');
    }
    if (new PublicKey(account.publicKey).toBase58() !== account.address) {
      throw new Error('Адрес кошелька не совпадает с его публичным ключом. Подписание заблокировано.');
    }
  }

  return {
    isPhantom: true,
    chain: DEVNET_CHAIN,
    get publicKey() {
      const account = currentAccount();
      return account ? new PublicKey(account.publicKey) : null;
    },
    assertReady,
    async connect() {
      if (!wallet.chains.includes(DEVNET_CHAIN)) {
        throw new Error('Эта версия кошелька не поддерживает явный запрос Solana devnet. Обновите Phantom.');
      }
      await connect.connect();
      assertReady();
      return { publicKey: new PublicKey(currentAccount()!.publicKey) };
    },
    async signTransaction(transaction) {
      assertReady();
      const account = currentAccount()!;
      if (transaction.feePayer?.toBase58() !== account.address) {
        throw new Error('Кошелёк изменился. Подготовьте проверку заново.');
      }
      const results = await sign.signTransaction({
        account,
        chain: DEVNET_CHAIN,
        transaction: new Uint8Array(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })),
        options: { preflightCommitment: 'confirmed' },
      });
      const result = results[0];
      if (results.length !== 1 || !result?.signedTransaction) {
        throw new Error('Кошелёк не вернул подписанную транзакцию. Отправка не выполнялась.');
      }
      return Transaction.from(Buffer.from(result.signedTransaction));
    },
    subscribe(listener) {
      return features[StandardEvents]?.on('change', change => {
        if (change.accounts || change.chains || change.features) listener();
      }) ?? (() => {});
    },
  };
}

export function getProvider(): PhantomProvider | null {
  for (const wallet of getWallets().get()) {
    const provider = adaptPhantomWallet(wallet);
    if (provider) return provider;
  }
  return null;
}

export function isRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
}

export function errorMessage(error: unknown, walletRequest = false): string {
  if (walletRequest && isRejection(error)) return 'Подпись отклонена в кошельке.';
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'
    || (error instanceof TypeError && /fetch|network/i.test(error.message)))) {
    return 'Solana не ответила. Проверьте соединение и повторите проверку подтверждения, не подпись.';
  }
  return error instanceof Error ? error.message : 'Не удалось выполнить операцию. Проверьте соединение и попробуйте снова.';
}
