import { useEffect, useRef, useState } from 'react';
import { browseLink, explorerLink } from './wallet/config';
import { clearProbe, commitReconciliation, loadProbe, WalletBusyError, withWalletLock, type Probe } from './wallet/journal';
import { errorMessage, getProvider } from './wallet/provider';
import { abandonProbe, broadcastProbe, prepareProbe, reconcileProbe, signProbe, type PreparedProbe } from './wallet/probe';
import { DevnetRpc } from './wallet/rpc';

const rpc = new DevnetRpc();

function sol(lamports: number): string {
  return (lamports / 1_000_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 9 });
}

export function App() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [providerAvailable, setProviderAvailable] = useState(Boolean(getProvider()));
  const [prepared, setPrepared] = useState<PreparedProbe | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abandonAcknowledged, setAbandonAcknowledged] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'prepare' | 'sign' | 'check' | 'abandon' | null>(null);
  const checking = useRef<Promise<void> | null>(null);
  const preparing = useRef(false);
  const walletRef = useRef<string | null>(null);
  let phoneLink: string | null = null;
  try { phoneLink = browseLink(window.location.href); } catch { /* HTTPS is required on a phone. */ }

  useEffect(() => {
    try {
      const saved = loadProbe(localStorage);
      setProbe(saved);
      if (saved?.state === 'pending' && saved.detail) setError(saved.detail);
    } catch (cause) { setStorageError(errorMessage(cause)); }
    const refresh = () => setProviderAvailable(Boolean(getProvider()));
    const timer = window.setInterval(refresh, 500);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    const provider = getProvider();
    const accountChanged = () => {
      walletRef.current = null;
      setWallet(null);
      setPrepared(null);
    };
    return provider?.subscribe?.(accountChanged);
  }, [providerAvailable]);

  async function connect() {
    setError(null);
    setBusy('connect');
    try {
      const provider = getProvider();
      if (!provider) throw new Error('Откройте страницу в Phantom или установите расширение на ноутбуке.');
      const { publicKey } = await provider.connect();
      walletRef.current = publicKey.toBase58();
      setWallet(walletRef.current);
      setPrepared(null);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function prepare() {
    if (!wallet || preparing.current) return;
    preparing.current = true;
    setError(null);
    setPrepared(null);
    setBusy('prepare');
    try {
      const result = await prepareProbe(rpc, wallet);
      if (walletRef.current === wallet) setPrepared(result);
    } catch (cause) { setError(errorMessage(cause)); }
    finally {
      preparing.current = false;
      setBusy(null);
    }
  }

  async function sign() {
    if (!prepared) return;
    setError(null);
    setBusy('sign');
    try {
      await withWalletLock(async () => {
        const provider = getProvider();
        if (!provider) throw new Error('Кошелёк недоступен. Снова откройте страницу в Phantom.');
        setProbe(await signProbe(rpc, provider, prepared, localStorage, setProbe));
        setPrepared(null);
      });
      void check(true);
    } catch (cause) {
      setError(errorMessage(cause));
      try { setProbe(loadProbe(localStorage)); } catch (storageCause) { setStorageError(errorMessage(storageCause)); }
    } finally { setBusy(null); }
  }

  async function check(automatic = false) {
    if (automatic && checking.current) return;
    if (!automatic) {
      setError(null);
      setBusy('check');
    }
    const previous = checking.current;
    const operation = (async () => {
      await previous;
      try {
        if (automatic) {
          const current = loadProbe(localStorage);
          if (!current) return;
          const result = await reconcileProbe(rpc, current);
          await withWalletLock(async () => {
            const committed = commitReconciliation(localStorage, result);
            setProbe(committed);
            if (committed?.state !== 'pending') setError(null);
          });
        } else {
          await withWalletLock(async () => {
            const current = loadProbe(localStorage);
            if (!current) return;
            const result = await reconcileProbe(rpc, current);
            let committed = commitReconciliation(localStorage, result);
            if (committed?.state === 'pending' && committed.signedTransaction) {
              committed = await broadcastProbe(rpc, localStorage, committed.id);
            }
            setProbe(committed);
            if (committed?.state !== 'pending') setError(null);
          });
        }
      } catch (cause) {
        if (!automatic || !(cause instanceof WalletBusyError)) setError(errorMessage(cause));
      } finally { if (!automatic) setBusy(null); }
    })();
    checking.current = operation;
    try { await operation; }
    finally { if (checking.current === operation) checking.current = null; }
  }

  useEffect(() => {
    if (probe?.state !== 'pending') return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      void check(true);
      if (attempts >= 8) window.clearInterval(timer);
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [probe?.id, probe?.state, probe?.signature]);

  useEffect(() => { setAbandonAcknowledged(false); }, [probe?.id, probe?.state]);

  async function abandon() {
    if (!probe) return;
    setError(null);
    setBusy('abandon');
    try {
      await withWalletLock(async () => {
        setProbe(await abandonProbe(rpc, localStorage, probe.id, abandonAcknowledged));
        setPrepared(null);
      });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(null); }
  }

  async function reset() {
    setError(null);
    try {
      await withWalletLock(async () => clearProbe(localStorage));
      setProbe(null);
      setPrepared(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }

  const locked = Boolean(busy || storageError);
  const address = probe?.wallet ?? wallet;

  return (
    <main>
      <header>
        <a className="wordmark" href="/" aria-label="Field, проверка кошелька">Field</a>
        <span className="network">Solana devnet</span>
      </header>

      <h1>Проверка кошелька</h1>
      <p className="intro">Проверяем подписание с телефона до подключения оплаты заданий.</p>
      <p className="disclosure">{probe?.version === 1
        ? 'Старая проверка использовала интерфейс кошелька без явно указанной сети. Это не оплата задания, но исход и комиссия прежней попытки могут остаться неизвестными.'
        : 'Это не оплата задания. Транзакция запишет публичную метку проверки. Перевода средств нет, списывается только комиссия в тестовых SOL.'}</p>

      {storageError && <p role="alert" className="error">{storageError}</p>}
      {error && <p role="alert" className="error">{error}</p>}

      {!probe && !wallet && (
        <section aria-labelledby="connect-heading">
          <h2 id="connect-heading">Подключить Phantom</h2>
          <p>Используйте отдельный тестовый кошелёк. Включите тестовые сети в Phantom и выберите Solana devnet.</p>
          {providerAvailable ? (
            <button disabled={locked} onClick={() => void connect()}>{busy === 'connect' ? 'Подключаем…' : 'Подключить кошелёк'}</button>
          ) : (
            <>
              {window.phantom?.solana?.isPhantom && <p role="alert" className="error">Эта версия Phantom не предоставляет нужный интерфейс Wallet Standard. Обновите кошелёк. Подписание без явно указанной сети отключено.</p>}
              {phoneLink ? (
                <a className="button" href={phoneLink}>Открыть в Phantom на телефоне</a>
              ) : (
                <p>Для телефона нужна HTTPS-ссылка на эту страницу. Адрес localhost доступен только на этом компьютере.</p>
              )}
              <p className="secondary">На ноутбуке можно использовать <a href="https://phantom.com/" target="_blank" rel="noreferrer">расширение Phantom</a>.</p>
            </>
          )}
        </section>
      )}

      {address && (
        <section aria-labelledby="wallet-heading">
          <h2 id="wallet-heading">Кошелёк проверки</h2>
          <p className="address">{address}</p>
          {!probe && !prepared && (
            <button disabled={locked} onClick={() => void prepare()}>{busy === 'prepare' ? 'Проверяем devnet…' : 'Подготовить проверку'}</button>
          )}
        </section>
      )}

      {!probe && prepared && (
        <section aria-labelledby="preview-heading">
          <h2 id="preview-heading">Перед подписанием</h2>
          <dl>
            <div><dt>Сеть запроса кошельку</dt><dd>Solana devnet</dd></div>
            <div><dt>Симуляция в devnet</dt><dd>Пройдена</dd></div>
            <div><dt>Перевод</dt><dd>0 SOL</dd></div>
            <div><dt>Расчётная комиссия</dt><dd>{sol(prepared.probe.feeLamports)} тестовых SOL</dd></div>
            <div><dt>Баланс devnet</dt><dd>{sol(prepared.balanceLamports)} тестовых SOL</dd></div>
          </dl>
          <p className="secondary">Метка и адрес кошелька будут публичными. В транзакции нет данных задания или отчёта.</p>
          <p>Если Phantom показывает ошибку симуляции или «Confirm (unsafe)», закройте окно. Не подтверждайте небезопасный запрос.</p>
          <button disabled={locked} onClick={() => void sign()}>{busy === 'sign' ? 'Ожидаем кошелёк…' : 'Подписать проверку'}</button>
          <button className="quiet" disabled={locked} onClick={() => void prepare()}>Подготовить заново</button>
        </section>
      )}

      {probe && (
        <section aria-labelledby="result-heading">
          <div role="status" aria-live="polite">
            <h2 id="result-heading">
              {probe.state === 'pending' && 'Результат пока не подтверждён'}
              {probe.state === 'finalized' && 'Подтверждено в Solana devnet'}
              {probe.state === 'failed' && 'Транзакция завершилась ошибкой'}
              {probe.state === 'rejected' && 'Подпись отклонена'}
              {probe.state === 'abandoned' && 'Ожидание прекращено вручную'}
            </h2>
            {probe.state === 'pending' && <p>Не подписывайте новую проверку. Проверим существующую транзакцию, даже если ответ кошелька потерялся.</p>}
            {probe.state === 'finalized' && <p>Подписание и выполнение подтверждены сетью на уровне finalized. Это проверка кошелька, не escrow и не выплата исполнителю.</p>}
            {probe.state === 'failed' && <p>{probe.detail}</p>}
            {probe.state === 'rejected' && <p>Кошелёк отклонил запрос на подпись. Можно подготовить новую проверку.</p>}
            {probe.state === 'abandoned' && <p>Исходная запись и ваше согласие сохранены в локальном архиве. Результат и возможная комиссия остаются неизвестными. Новая devnet-проверка потребует отдельной подписи.</p>}
          </div>
          <dl>
            <div><dt>Проверка</dt><dd className="break">{probe.id}</dd></div>
            <div><dt>Создана</dt><dd>{new Date(probe.createdAt).toLocaleString('ru-RU')}</dd></div>
            <div><dt>{probe.version === 1 ? 'Сохранённый расчёт devnet' : 'Расчётная комиссия'}</dt><dd>{sol(probe.feeLamports)} тестовых SOL</dd></div>
          </dl>
          {probe.signature && <a className="external" href={explorerLink(probe.signature)} target="_blank" rel="noreferrer">Посмотреть транзакцию в Solana Explorer</a>}
          {probe.state === 'pending' ? (
            <button disabled={Boolean(storageError) || busy === 'check' || busy === 'abandon'} onClick={() => void check()}>
              {busy === 'check' ? 'Проверяем сеть…' : 'Проверить подтверждение'}
            </button>
          ) : (
            <button className="quiet" disabled={locked} onClick={() => void reset()}>Начать новую проверку</button>
          )}
          {probe.state === 'pending' && !probe.signature && (
            <details className="recovery">
              <summary>Зависшая тестовая проверка</summary>
              <p>Только для этого эксперимента можно сохранить запись и прекратить ожидание вручную. Это не доказательство отсутствия исполнения или комиссии. Для платежей такое завершение не допускается.</p>
              <p>Закройте все запросы Phantom. Если кошелёк ещё ожидает ответ, закройте запрос и обновите страницу. Ручное завершение доступно только после истечения исходного blockhash, проверенного через devnet RPC.</p>
              <label className="consent">
                <input type="checkbox" checked={abandonAcknowledged} disabled={locked} onChange={event => setAbandonAcknowledged(event.target.checked)} />
                <span>Все окна подписи закрыты. Я понимаю, что результат и комиссия прежней проверки остаются неизвестными.</span>
              </label>
              <button className="quiet" disabled={locked || !abandonAcknowledged} onClick={() => void abandon()}>
                {busy === 'abandon' ? 'Проверяем и сохраняем архив…' : 'Сохранить в архиве и прекратить ожидание'}
              </button>
            </details>
          )}
        </section>
      )}

      <footer>
        <a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">Получить тестовые SOL</a>
        <p>Состояние проверки сохраняется в этом браузере. Переход в другой браузер не переносит его. Не очищайте данные сайта до выяснения результата.</p>
      </footer>
    </main>
  );
}
