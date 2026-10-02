import { z } from 'zod';
import { JOURNAL_KEY } from './config';

const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export const probeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  id: z.uuid(),
  wallet: z.string().min(32).max(44).regex(base58),
  createdAt: z.iso.datetime(),
  blockhash: z.string().min(32).max(44).regex(base58),
  lastValidBlockHeight: z.number().int().nonnegative(),
  message: z.string().min(1).max(2000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  feeLamports: z.number().int().nonnegative(),
  state: z.enum(['pending', 'finalized', 'failed', 'rejected', 'abandoned']),
  signature: z.string().min(64).max(88).regex(base58).optional(),
  detail: z.string().max(500).optional(),
  signedTransaction: z.string().min(1).max(2400).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional(),
  stage: z.enum(['wallet', 'signed', 'broadcast']).optional(),
}).strict().refine(probe => (probe.state !== 'finalized' || probe.signature !== undefined)
  && (!probe.signedTransaction || probe.signature !== undefined));

export type Probe = z.infer<typeof probeSchema>;
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const abandonmentSchema = z.object({
  original: probeSchema.refine(probe => probe.state === 'pending' && probe.signature === undefined),
  acknowledgedAt: z.iso.datetime(),
  finalizedBlockHeight: z.number().int().nonnegative(),
  originalBlockhashExpired: z.literal(true),
  walletPromptsClosed: z.literal(true),
  outcomeUnknownAcknowledged: z.literal(true),
  reason: z.literal('manual_end_of_wallet_experiment'),
}).strict().refine(entry => entry.finalizedBlockHeight > entry.original.lastValidBlockHeight);

const journalSchema = z.object({
  format: z.literal('field-wallet-journal'),
  active: probeSchema.nullable(),
  archive: z.array(abandonmentSchema).max(100),
}).strict().refine(journal => {
  if (journal.active?.state !== 'abandoned') return true;
  return journal.archive.some(entry => entry.original.id === journal.active!.id
    && entry.original.message === journal.active!.message && entry.original.wallet === journal.active!.wallet);
});

type Journal = z.infer<typeof journalSchema>;

function readJournal(storage: JournalStorage): Journal {
  const raw = storage.getItem(JOURNAL_KEY);
  if (raw === null) return { format: 'field-wallet-journal', active: null, archive: [] };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'format' in value) return journalSchema.parse(value);
    const active = probeSchema.parse(value);
    if (active.state === 'abandoned') throw new Error('Abandonment archive missing');
    return { format: 'field-wallet-journal', active, archive: [] };
  } catch {
    throw new Error('Сохранённая проверка или её архив повреждены. Не подписывайте новую операцию, пока не выяснен результат прежней.');
  }
}

function writeJournal(storage: JournalStorage, journal: Journal): void {
  const checked = journalSchema.parse(journal);
  if (checked.archive.length > 0) {
    storage.setItem(JOURNAL_KEY, JSON.stringify(checked));
  } else if (checked.active) {
    storage.setItem(JOURNAL_KEY, JSON.stringify(checked.active));
  } else {
    storage.removeItem(JOURNAL_KEY);
  }
}

export function loadProbe(storage: JournalStorage): Probe | null {
  return readJournal(storage).active;
}

export function saveProbe(storage: JournalStorage, probe: Probe): void {
  writeJournal(storage, { ...readJournal(storage), active: probeSchema.parse(probe) });
}

export function clearProbe(storage: JournalStorage): void {
  const journal = readJournal(storage);
  if (journal.active?.state === 'pending') {
    throw new Error('Сначала выясните результат незавершённой транзакции.');
  }
  writeJournal(storage, { ...journal, active: null });
}

export function archiveUnknownProbe(storage: JournalStorage, original: Probe, finalizedBlockHeight: number): Probe {
  const journal = readJournal(storage);
  if (journal.active?.id !== original.id || journal.active.state !== 'pending' || journal.active.signature
    || journal.active.message !== original.message) {
    throw new Error('Состояние проверки изменилось. Снова проверьте её результат.');
  }
  const entry = abandonmentSchema.parse({
    original: journal.active,
    acknowledgedAt: new Date().toISOString(), finalizedBlockHeight,
    originalBlockhashExpired: true, walletPromptsClosed: true, outcomeUnknownAcknowledged: true,
    reason: 'manual_end_of_wallet_experiment',
  });
  const active: Probe = { ...journal.active, state: 'abandoned' };
  writeJournal(storage, { ...journal, active, archive: [...journal.archive, entry] });
  return active;
}

export class WalletBusyError extends Error {
  constructor() { super('Другая операция с кошельком ещё выполняется. Дождитесь её завершения.'); }
}

export function commitReconciliation(storage: JournalStorage, result: Probe): Probe | null {
  const latest = loadProbe(storage);
  if (latest?.id === result.id && latest.state === 'pending' && result.state !== 'pending') {
    if (latest.message !== result.message || latest.wallet !== result.wallet
      || (latest.signature && result.signature && latest.signature !== result.signature)) {
      throw new Error('Результат проверки не совпадает с сохранённой транзакцией.');
    }
    const committed: Probe = {
      ...latest, state: result.state, signature: result.signature ?? latest.signature, detail: result.detail,
    };
    saveProbe(storage, committed);
    return committed;
  }
  return latest;
}

export async function withWalletLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    throw new Error('Браузер не поддерживает защиту от повторного подписания. Обновите браузер или Phantom.');
  }
  return navigator.locks.request('field.wallet-check', { ifAvailable: true }, async lock => {
    if (!lock) throw new WalletBusyError();
    return action();
  });
}
