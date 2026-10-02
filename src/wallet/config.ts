export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const JOURNAL_KEY = 'field.wallet-check.v1';

export function browseLink(pageUrl: string): string {
  const url = new URL(pageUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Для открытия на телефоне нужна HTTPS-ссылка.');
  }
  if (url.username || url.password) {
    throw new Error('Ссылка не должна содержать учётные данные.');
  }
  url.search = '';
  url.hash = '';
  return `https://phantom.app/ul/browse/${encodeURIComponent(url.href)}?ref=${encodeURIComponent(url.origin)}`;
}

export function explorerLink(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}
