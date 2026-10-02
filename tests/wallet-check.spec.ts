import { expect, test, type Page } from '@playwright/test';
import { Keypair, Message, PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'node:buffer';
import bs58 from 'bs58';
import { DEVNET_GENESIS, DEVNET_RPC, JOURNAL_KEY } from '../src/wallet/config';
import { encodeMessage, makeTransaction } from '../src/wallet/rpc';

const signer = Keypair.fromSeed(new Uint8Array(32).fill(7));
const wallet = signer.publicKey.toBase58();
const blockhash = new PublicKey(new Uint8Array(32).fill(8)).toBase58();
const signatureBytes = new Uint8Array(64).fill(7);
const signature = bs58.encode(signatureBytes);

type MockOptions = {
  genesis?: string;
  balance?: number;
  walletResult?: 'ok' | 'rejected' | 'lost';
  finalized?: boolean;
  recoverable?: boolean;
  transactionError?: boolean;
  blockhashValid?: boolean;
  simulationError?: boolean;
  walletChains?: string[];
  legacyOnly?: boolean;
  blockHeight?: number;
  sendError?: boolean;
  rpcUnavailable?: boolean;
};

async function mockWallet(page: Page, options: MockOptions = {}) {
  await page.exposeFunction('fieldTestSign', (bytes: number[]) => {
    const transaction = Transaction.from(Buffer.from(bytes));
    transaction.sign(signer);
    return Array.from(transaction.serialize());
  });
  await page.addInitScript(({ wallet, publicKey, result, chains, legacyOnly }) => {
    Object.assign(window, { phantom: { solana: { isPhantom: true } } });
    if (legacyOnly) return;
    const account = { address: wallet, publicKey: new Uint8Array(publicKey), chains, features: ['solana:signTransaction'] };
    let accounts: typeof account[] = [];
    const standardWallet = {
      version: '1.0.0', name: 'Phantom', icon: 'data:image/svg+xml;base64,', chains,
      get accounts() { return accounts; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { accounts = [account]; return { accounts }; } },
        'standard:events': { version: '1.0.0', on: () => () => {} },
        'solana:signTransaction': {
          version: '1.0.0', supportedTransactionVersions: ['legacy'],
          signTransaction: async (input: { chain: string; transaction: Uint8Array }) => {
            if (input.chain !== 'solana:devnet') throw new Error('Unsafe wallet request');
            localStorage.setItem('field-test-request-chain', input.chain);
            const key = 'field-test-sign-count';
            localStorage.setItem(key, String(Number(localStorage.getItem(key) ?? 0) + 1));
            const outcome = localStorage.getItem('field-test-wallet-result') ?? result;
            if (outcome === 'rejected') throw { code: 4001 };
            if (outcome === 'lost') throw new Error('Ответ кошелька потерян');
            const sign = (window as unknown as { fieldTestSign: (bytes: number[]) => Promise<number[]> }).fieldTestSign;
            return [{ signedTransaction: new Uint8Array(await sign(Array.from(input.transaction))) }];
          },
        },
      },
    };
    window.addEventListener('wallet-standard:app-ready', event => {
      (event as CustomEvent<{ register: (wallet: unknown) => void }>).detail.register(standardWallet);
    });
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', {
      detail: (api: { register: (wallet: unknown) => void }) => api.register(standardWallet),
    }));
  }, { wallet, publicKey: Array.from(signer.publicKey.toBytes()), result: options.walletResult ?? 'ok', chains: options.walletChains ?? ['solana:mainnet', 'solana:devnet'], legacyOnly: options.legacyOnly ?? false });

  await page.route(DEVNET_RPC, async route => {
    if (options.rpcUnavailable) { await route.abort('internetdisconnected'); return; }
    const request = route.request().postDataJSON();
    let result: unknown;
    switch (request.method) {
      case 'sendTransaction': {
        expect(request.params[1].skipPreflight).not.toBe(true);
        expect(request.params[1].preflightCommitment).toBe('confirmed');
        expect(request.params[1].maxRetries).toBe(5);
        const signed = Transaction.from(Buffer.from(request.params[0], 'base64'));
        expect(signed.verifySignatures(true)).toBe(true);
        const record = await page.evaluate(key => {
          const stored = JSON.parse(localStorage.getItem(key)!);
          return stored.format === 'field-wallet-journal' ? stored.active : stored;
        }, JOURNAL_KEY);
        expect(record.signature).toBe(bs58.encode(signed.signature!));
        expect(record.signedTransaction).toBe(request.params[0]);
        if (options.sendError) {
          await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'RPC send response lost' } } });
          return;
        }
        result = record.signature;
        break;
      }
      case 'getGenesisHash': result = options.genesis ?? DEVNET_GENESIS; break;
      case 'getLatestBlockhash': result = { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 100 } }; break;
      case 'isBlockhashValid': result = { context: { slot: 1 }, value: options.blockhashValid ?? true }; break;
      case 'getBlockHeight': result = options.blockHeight ?? 101; break;
      case 'getBalance': result = { context: { slot: 1 }, value: options.balance ?? 1_000_000 }; break;
      case 'getFeeForMessage': result = { context: { slot: 1 }, value: 5000 }; break;
      case 'simulateTransaction':
        expect(request.params[1].sigVerify).toBe(false);
        result = { context: { slot: 1 }, value: { err: options.simulationError ? { InstructionError: [2, 'InvalidInstructionData'] } : null, logs: [], accounts: null, unitsConsumed: 1000 } };
        break;
      case 'getSignaturesForAddress': result = options.recoverable ? [{ signature, slot: 1, err: null, memo: null, blockTime: null, confirmationStatus: 'finalized' }] : []; break;
      case 'getTransaction': {
        expect(request.params[1].commitment).toBe('finalized');
        if (!options.finalized && !options.recoverable) { result = null; break; }
        const record = await page.evaluate(key => {
          const stored = JSON.parse(localStorage.getItem(key)!);
          return stored.format === 'field-wallet-journal' ? stored.active : stored;
        }, JOURNAL_KEY);
        const message = Message.from(Buffer.from(record.message, 'base64'));
        result = {
          slot: 1,
          blockTime: 1_700_000_000,
          transaction: {
            signatures: [signature],
            message: {
              header: message.header,
              accountKeys: message.accountKeys.map(key => key.toBase58()),
              recentBlockhash: message.recentBlockhash,
              instructions: message.instructions,
            },
          },
          meta: {
            err: options.transactionError ? { InstructionError: [0, 'InvalidInstructionData'] } : null,
            fee: 5000, preBalances: message.accountKeys.map((_, i) => i === 0 ? 1_000_000 : 0), postBalances: message.accountKeys.map((_, i) => i === 0 ? 995_000 : 0),
            innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], rewards: [],
          },
          version: 'legacy',
        };
        break;
      }
      default: throw new Error(`Unexpected RPC method ${request.method}`);
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}

async function prepare(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await page.getByRole('button', { name: 'Подготовить проверку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Перед подписанием' })).toBeVisible();
}

async function sign(page: Page) {
  await prepare(page);
  await page.getByRole('button', { name: 'Подписать проверку', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Результат пока не подтверждён|Подпись отклонена|Подтверждено в Solana devnet/ })).toBeVisible();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('no-wallet state is truthful and has no signing action', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Проверка кошелька', exact: true })).toBeVisible();
  await expect(page.getByText('Для телефона нужна HTTPS-ссылка', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подписать проверку' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('HTTPS page offers the real Phantom browse link without query data', async ({ page }, testInfo) => {
  await page.route('https://field.example/**', async route => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}` });
    await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('https://field.example/?token=private#secret');
  const link = page.getByRole('link', { name: 'Открыть в Phantom на телефоне' });
  await expect(link).toHaveAttribute('href', 'https://phantom.app/ul/browse/https%3A%2F%2Ffield.example%2F?ref=https%3A%2F%2Ffield.example');
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('phone-entry.png'), fullPage: true });
});

test('legacy-only provider cannot silently fall back to an unspecified network', async ({ page }) => {
  await mockWallet(page, { legacyOnly: true });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Wallet Standard');
  await expect(page.getByRole('button', { name: 'Подключить кошелёк' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBeNull();
});

test('mainnet-only wallet cannot connect or sign', async ({ page }) => {
  await mockWallet(page, { walletChains: ['solana:mainnet'] });
  await page.goto('/');
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await expect(page.getByRole('alert')).toContainText('Solana devnet');
  await expect(page.getByRole('button', { name: 'Подготовить проверку', exact: true })).toHaveCount(0);
});

test('failed devnet simulation never reaches a wallet prompt', async ({ page }) => {
  await mockWallet(page, { simulationError: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await page.getByRole('button', { name: 'Подготовить проверку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Симуляция в Solana devnet не прошла');
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), JOURNAL_KEY)).toBeNull();
});

test('network rejection prevents signing', async ({ page }) => {
  await mockWallet(page, { genesis: 'not-devnet' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await page.getByRole('button', { name: 'Подготовить проверку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('не к Solana devnet');
  await expect(page.getByRole('button', { name: 'Подписать проверку' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBeNull();
});

test('expired preview requires preparation again without a wallet call', async ({ page }) => {
  await mockWallet(page, { blockhashValid: false });
  await prepare(page);
  await page.getByRole('button', { name: 'Подписать проверку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('устарела');
  expect(await page.evaluate(key => localStorage.getItem(key), JOURNAL_KEY)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBeNull();
});

test('insufficient test SOL is actionable without signing', async ({ page }) => {
  await mockWallet(page, { balance: 0 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await page.getByRole('button', { name: 'Подготовить проверку', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Недостаточно тестовых SOL');
  await expect(page.getByRole('link', { name: 'Получить тестовые SOL' })).toBeVisible();
});

test('success requires finalized RPC data and survives reload', async ({ page }) => {
  await mockWallet(page, { finalized: true });
  await sign(page);
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('field-test-request-chain'))).toBe('solana:devnet');
  await expect(page.getByRole('link', { name: 'Посмотреть транзакцию в Solana Explorer' })).toHaveAttribute('href', /cluster=devnet/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
});

test('missing finalized transaction is pending and reload does not sign again', async ({ page }) => {
  await mockWallet(page);
  await sign(page);
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('heading', { name: 'Результат пока не подтверждён' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('button', { name: 'Подписать проверку' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Начать новую проверку' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
});

test('lost RPC send response is recovered without another signature', async ({ page }) => {
  await mockWallet(page, { sendError: true, recoverable: true });
  await sign(page);
  await expect(page.getByRole('alert')).toContainText('RPC send response lost');
  await page.reload();
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
});

test('manual check waits for an in-flight automatic read instead of disappearing', async ({ page }) => {
  const options: MockOptions = {};
  const sends: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).href !== new URL(DEVNET_RPC).href || request.method() !== 'POST') return;
    const rpcRequest = request.postDataJSON();
    if (rpcRequest.method === 'sendTransaction') sends.push(rpcRequest.params[0]);
  });
  await mockWallet(page, options);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let held = false;
  await page.route(DEVNET_RPC, async route => {
    if (route.request().postDataJSON().method === 'getTransaction' && !held) {
      held = true;
      started();
      await gate;
    }
    await route.fallback();
  });
  await sign(page);
  await reading;
  expect(sends).toHaveLength(1);
  options.sendError = true;
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('button', { name: 'Проверяем сеть…' })).toBeDisabled();
  expect(sends).toHaveLength(1);
  release();
  await expect(page.getByRole('alert')).toContainText('RPC send response lost');
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
  expect(sends).toHaveLength(2);
  expect(sends[1]).toBe(sends[0]);
});

test('explicit rejection permits a fresh check', async ({ page }) => {
  await mockWallet(page, { walletResult: 'rejected' });
  await sign(page);
  await expect(page.getByRole('heading', { name: 'Подпись отклонена' })).toBeVisible();
  await page.getByRole('button', { name: 'Начать новую проверку' }).click();
  await expect(page.getByRole('heading', { name: 'Подпись отклонена' })).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), JOURNAL_KEY)).toBeNull();
});

test('finalized execution failure never displays success', async ({ page }) => {
  await mockWallet(page, { finalized: true, transactionError: true });
  await prepare(page);
  await page.getByRole('button', { name: 'Подписать проверку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Транзакция завершилась ошибкой' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toHaveCount(0);
});

test('RPC outage leaves the existing operation pending', async ({ page }) => {
  const options: MockOptions = {};
  await mockWallet(page, options);
  await sign(page);
  await expect(page.getByRole('link', { name: 'Посмотреть транзакцию в Solana Explorer' })).toBeVisible();
  options.rpcUnavailable = true;
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Результат пока не подтверждён' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
});

test('manual exit archives an expired unknown check and requires a separate fresh signature', async ({ page }, testInfo) => {
  const options: MockOptions = { walletResult: 'lost' };
  await mockWallet(page, options);
  await sign(page);
  const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), JOURNAL_KEY);
  await page.reload();
  await page.getByText('Зависшая тестовая проверка', { exact: true }).click();
  const archiveButton = page.getByRole('button', { name: 'Сохранить в архиве и прекратить ожидание' });
  await expect(archiveButton).toBeDisabled();
  await page.getByRole('checkbox').check();
  await archiveButton.click();
  await expect(page.getByRole('alert')).toContainText('ещё может быть исполнена');
  options.blockhashValid = false;
  await page.setViewportSize({ width: 360, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('manual-recovery-360.png'), fullPage: true });
  await archiveButton.click();
  await expect(page.getByRole('heading', { name: 'Ожидание прекращено вручную' })).toBeVisible();
  const archived = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), JOURNAL_KEY);
  expect(archived.archive[0].original).toEqual(original);
  expect(archived.archive[0].outcomeUnknownAcknowledged).toBe(true);
  expect(archived.active.state).toBe('abandoned');
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ожидание прекращено вручную' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('archived-360.png'), fullPage: true });
  await page.getByRole('button', { name: 'Начать новую проверку' }).click();
  await page.getByRole('button', { name: 'Подключить кошелёк' }).click();
  await page.getByRole('button', { name: 'Подготовить проверку', exact: true }).click();
  options.blockhashValid = true;
  await page.evaluate(() => localStorage.setItem('field-test-wallet-result', 'ok'));
  await page.getByRole('button', { name: 'Подписать проверку', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('2');
  await expect(page.getByRole('link', { name: 'Посмотреть транзакцию в Solana Explorer' })).toBeVisible();
  options.finalized = true;
  await page.getByRole('button', { name: 'Проверить подтверждение' }).click();
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toBeVisible();
  const completed = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), JOURNAL_KEY);
  expect(completed.active.id).not.toBe(original.id);
  expect(completed.archive[0].original).toEqual(original);
});

test('legacy unknown check shows honest network and fee disclosure', async ({ page }, testInfo) => {
  await mockWallet(page);
  const id = crypto.randomUUID();
  const legacy = {
    version: 1, id, wallet, blockhash, lastValidBlockHeight: 100,
    createdAt: new Date().toISOString(), feeLamports: 5000, state: 'pending',
    message: encodeMessage(makeTransaction(wallet, blockhash, id, 1)),
  };
  await page.addInitScript(({ key, legacy }) => localStorage.setItem(key, JSON.stringify(legacy)), { key: JOURNAL_KEY, legacy });
  await page.goto('/');
  await expect(page.getByText('Старая проверка использовала интерфейс кошелька', { exact: false })).toBeVisible();
  await expect(page.getByText('Сохранённый расчёт devnet', { exact: true })).toBeVisible();
  await page.getByText('Зависшая тестовая проверка', { exact: true }).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`legacy-recovery-${width}.png`), fullPage: true });
  }
});

test('known signature has no manual abandonment control', async ({ page }) => {
  await mockWallet(page);
  await sign(page);
  await expect(page.getByText('Зависшая тестовая проверка', { exact: true })).toHaveCount(0);
});

test('corrupt journal blocks signing instead of silently starting over', async ({ page }) => {
  await mockWallet(page);
  await page.addInitScript(key => localStorage.setItem(key, '{broken'), JOURNAL_KEY);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('повреждены');
  await expect(page.getByRole('button', { name: 'Подключить кошелёк' })).toBeDisabled();
});

test('cross-tab lock and journal prevent duplicate wallet calls', async ({ page, context }) => {
  await mockWallet(page);
  await prepare(page);
  const second = await context.newPage();
  await mockWallet(second);
  await prepare(second);
  await Promise.all([
    page.getByRole('button', { name: 'Подписать проверку', exact: true }).click(),
    second.getByRole('button', { name: 'Подписать проверку', exact: true }).click(),
  ]);
  await expect.poll(() => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return (stored.format === 'field-wallet-journal' ? stored.active : stored)?.signature;
  }, JOURNAL_KEY)).toBeTruthy();
  expect(await page.evaluate(() => localStorage.getItem('field-test-sign-count'))).toBe('1');
  await second.close();
});

test('responsive layout and keyboard actions at mobile, tablet and desktop widths', async ({ page }, testInfo) => {
  await mockWallet(page, { finalized: true });
  await prepare(page);
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    const button = page.getByRole('button', { name: 'Подписать проверку', exact: true });
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath(`preview-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('preview-enlarged.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  const button = page.getByRole('button', { name: 'Подписать проверку', exact: true });
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toBeFocused();
  expect(await button.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Подтверждено в Solana devnet' })).toBeVisible();
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`result-${width}.png`), fullPage: true });
  }
});

test('no-wallet screen reflows without clipped controls', async ({ page }, testInfo) => {
  await page.goto('/');
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`empty-${width}.png`), fullPage: true });
  }
});
