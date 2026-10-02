import { Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { archiveUnknownProbe, commitReconciliation, loadProbe, saveProbe, type JournalStorage, type Probe, probeSchema } from './journal';
import { DEVNET_CHAIN, errorMessage, isRejection, type PhantomProvider } from './provider';
import { encodeMessage, makeTransaction, validateProbe, validateSignedTransaction, type ProbeRpc } from './rpc';

export interface PreparedProbe {
  probe: Probe;
  transaction: Transaction;
  balanceLamports: number;
}

export async function prepareProbe(rpc: ProbeRpc, wallet: string): Promise<PreparedProbe> {
  await rpc.assertDevnet();
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
  const id = crypto.randomUUID();
  const transaction = makeTransaction(wallet, blockhash, id);
  const [feeLamports, balanceLamports] = await Promise.all([rpc.fee(transaction), rpc.balance(wallet)]);
  if (feeLamports === null) throw new Error('Не удалось рассчитать комиссию. Подготовьте проверку ещё раз.');
  if (balanceLamports < feeLamports) {
    throw new Error('Недостаточно тестовых SOL для комиссии. Получите их через Solana faucet и подготовьте проверку снова.');
  }
  await rpc.simulate(transaction);
  const probe = probeSchema.parse({
    version: 2, id, wallet, blockhash, lastValidBlockHeight,
    message: encodeMessage(transaction), feeLamports,
    createdAt: new Date().toISOString(), state: 'pending',
  });
  return { probe, transaction, balanceLamports };
}

export async function signProbe(
  rpc: ProbeRpc,
  provider: PhantomProvider,
  prepared: PreparedProbe,
  storage: JournalStorage,
  onSaved: (probe: Probe) => void = () => {},
): Promise<Probe> {
  const current = loadProbe(storage);
  if (current) throw new Error('Сначала завершите предыдущую проверку.');
  if (provider.chain !== DEVNET_CHAIN) throw new Error('Кошелёк не предоставляет явное подписание в Solana devnet.');
  provider.assertReady();
  validateProbe(prepared.probe);
  if (encodeMessage(prepared.transaction) !== prepared.probe.message) {
    throw new Error('Подготовленная транзакция была изменена. Подписание заблокировано.');
  }
  if (provider.publicKey?.toBase58() !== prepared.probe.wallet) {
    throw new Error('Кошелёк изменился. Подготовьте проверку заново.');
  }
  await rpc.assertDevnet();
  if (!await rpc.validBlockhash(prepared.probe.blockhash)) {
    throw new Error('Подготовленная транзакция устарела. Подготовьте проверку заново, затем подпишите.');
  }
  if (provider.publicKey?.toBase58() !== prepared.probe.wallet) {
    throw new Error('Кошелёк изменился. Подготовьте проверку заново.');
  }
  provider.assertReady();
  const fresh = await rpc.latestBlockhash();
  const transaction = makeTransaction(prepared.probe.wallet, fresh.blockhash, prepared.probe.id);
  const [fee, balance] = await Promise.all([rpc.fee(transaction), rpc.balance(prepared.probe.wallet)]);
  if (fee !== prepared.probe.feeLamports || balance < fee) {
    throw new Error('Комиссия или баланс изменились. Подготовьте проверку заново.');
  }
  await rpc.simulate(transaction);
  const pending: Probe = {
    ...prepared.probe, blockhash: fresh.blockhash, lastValidBlockHeight: fresh.lastValidBlockHeight,
    message: encodeMessage(transaction), stage: 'wallet',
  };
  if (provider.publicKey?.toBase58() !== pending.wallet) throw new Error('Кошелёк изменился. Подготовьте проверку заново.');
  provider.assertReady();
  saveProbe(storage, pending);
  onSaved(pending);
  let signed: Transaction;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signed = await Promise.race([
      provider.signTransaction(transaction),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Phantom не вернул подписанную транзакцию. Закройте окно кошелька. Field ничего не отправлял. Старая проверка сохранена.')), 60_000);
      }),
    ]);
  } catch (error) {
    const latest = loadProbe(storage);
    if (latest?.id === pending.id && latest.state === 'pending' && !latest.signature) {
      const result: Probe = {
        ...latest, detail: errorMessage(error, true).slice(0, 500),
        ...(isRejection(error) ? { state: 'rejected' as const } : {}),
      };
      saveProbe(storage, result);
      if (isRejection(error)) return result;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    const signature = validateSignedTransaction(pending, signed);
    const latest = loadProbe(storage);
    if (!latest || latest.id !== prepared.probe.id) {
      throw new Error('Сохранённая проверка изменилась. Не подписывайте новую транзакцию.');
    }
    if (latest.state === 'abandoned') {
      throw new Error('Эта проверка уже закрыта вручную. Поздний ответ кошелька не изменит новую проверку.');
    }
    if (latest.signature && latest.signature !== signature) {
      throw new Error('Ответ кошелька не совпадает с уже подтверждённой подписью.');
    }
    const result = probeSchema.parse({
      ...latest, signature, signedTransaction: Buffer.from(signed.serialize()).toString('base64'), stage: 'signed',
    });
    saveProbe(storage, result);
    onSaved(result);
  } catch (error) {
    const latest = loadProbe(storage);
    if (latest?.id === pending.id && latest.state === 'pending') {
      saveProbe(storage, { ...latest, detail: errorMessage(error).slice(0, 500) });
    }
    throw error;
  }
  return broadcastProbe(rpc, storage, pending.id);
}

export async function broadcastProbe(rpc: ProbeRpc, storage: JournalStorage, id: string): Promise<Probe> {
  const current = loadProbe(storage);
  if (!current || current.id !== id || current.state !== 'pending' || !current.signedTransaction) {
    throw new Error('Нет сохранённой подписанной транзакции для отправки.');
  }
  try {
    const transaction = Transaction.from(Buffer.from(current.signedTransaction, 'base64'));
    const signature = validateSignedTransaction(current, transaction);
    await rpc.assertDevnet();
    if (!await rpc.validBlockhash(current.blockhash)) {
      throw new Error('Подписанная транзакция устарела. Новая подпись не выполнялась. Проверьте результат в сети.');
    }
    const latest = loadProbe(storage);
    if (latest?.id !== id || latest.state !== 'pending' || latest.signedTransaction !== current.signedTransaction) {
      throw new Error('Сохранённая проверка изменилась. Отправка заблокирована.');
    }
    saveProbe(storage, { ...latest, stage: 'broadcast', detail: undefined });
    const returned = await rpc.send(transaction);
    if (returned !== signature) throw new Error('RPC вернул другую подпись. Результат отправки неизвестен.');
  } catch (error) {
    const after = loadProbe(storage);
    if (after?.id === id && after.state === 'pending' && after.signedTransaction === current.signedTransaction) {
      saveProbe(storage, { ...after, detail: errorMessage(error).slice(0, 500) });
    }
    throw error;
  }
  return loadProbe(storage)!;
}

export async function abandonProbe(rpc: ProbeRpc, storage: JournalStorage, id: string, acknowledged: boolean): Promise<Probe> {
  if (!acknowledged) throw new Error('Для ручного завершения нужно согласие с неизвестным результатом и возможной комиссией.');
  const current = loadProbe(storage);
  if (!current || current.id !== id || current.state !== 'pending' || current.signature) {
    throw new Error('Ручное завершение доступно только для проверки без полученной подписи.');
  }
  validateProbe(current);
  await rpc.assertDevnet();
  const [height, valid] = await Promise.all([rpc.finalizedBlockHeight(), rpc.validBlockhash(current.blockhash)]);
  if (valid || height <= current.lastValidBlockHeight) {
    throw new Error('Исходная транзакция ещё может быть исполнена. Ручное завершение пока заблокировано.');
  }
  const result = await reconcileProbe(rpc, current);
  if (result.state !== 'pending') {
    const committed = commitReconciliation(storage, result);
    if (!committed || committed.id !== id) throw new Error('Состояние проверки изменилось. Проверьте её результат.');
    return committed;
  }
  return archiveUnknownProbe(storage, current, height);
}

export async function reconcileProbe(rpc: ProbeRpc, probe: Probe): Promise<Probe> {
  validateProbe(probe);
  if (probe.state !== 'pending') return probe;
  await rpc.assertDevnet();

  if (probe.signature) {
    const transaction = await rpc.transaction(probe.signature);
    if (!transaction) return probe;
    if (transaction.message !== probe.message) {
      throw new Error('Подпись указывает на другую транзакцию. Успешный результат не подтверждён.');
    }
    return {
      ...probe,
      state: transaction.err === null ? 'finalized' : 'failed',
      ...(transaction.err === null ? {} : { detail: 'Solana подтвердила ошибку выполнения. Комиссия могла быть списана.' }),
    };
  }

  const signatures = await rpc.recentSignatures(probe.wallet);
  for (const signature of signatures) {
    const transaction = await rpc.transaction(signature);
    if (transaction?.message === probe.message) {
      return {
        ...probe, signature,
        state: transaction.err === null ? 'finalized' : 'failed',
        ...(transaction.err === null ? {} : { detail: 'Solana подтвердила ошибку выполнения. Комиссия могла быть списана.' }),
      };
    }
  }
  return probe;
}
