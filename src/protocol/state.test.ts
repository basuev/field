import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { ESCROW_PROGRAM_ID } from './escrow';
import { verifyEscrowAccount, type EscrowAccount } from './state';

const vector = JSON.parse(await readFile(new URL('../../fixtures/protocol-v1.json', import.meta.url), 'utf8'));
function account(): EscrowAccount {
  return { address: new PublicKey(vector.escrowAddress), owner: ESCROW_PROGRAM_ID, executable: false, data: Buffer.from(vector.fundedAccountHex, 'hex') };
}

test('funded account matches Rust serialization and all approved task terms', async () => {
  assert.deepEqual(await verifyEscrowAccount(vector.task, account()), { state: 'funded', fundedAt: vector.task.issuedAt + 1, reportHash: null });
});

test('foreign owner, address, executable account or malformed layout never proves funding', async () => {
  const wrong = new PublicKey(vector.task.requester);
  for (const data of [
    { ...account(), owner: wrong }, { ...account(), address: wrong }, { ...account(), executable: true },
    { ...account(), data: account().data.slice(1) }, { ...account(), data: new Uint8Array(235) },
  ]) await assert.rejects(verifyEscrowAccount(vector.task, data));
});

test('modified version, task hash, roles, price, deadlines or bump never proves funding', async () => {
  for (const offset of [8, 9, 25, 57, 89, 121, 153, 161, 169, 177, 185, 234]) {
    const changed = account();
    changed.data[offset] = changed.data[offset]! ^ 1;
    await assert.rejects(verifyEscrowAccount(vector.task, changed));
  }
});

test('state requires the corresponding immutable report commitment', async () => {
  for (const [byte, state] of [[1, 'submitted'], [2, 'disputed'], [3, 'paid']] as const) {
    const updated = account();
    updated.data[233] = byte;
    await assert.rejects(verifyEscrowAccount(vector.task, updated), /inconsistent/);
    updated.data.set(Buffer.from(vector.reportHash, 'hex'), 201);
    assert.equal((await verifyEscrowAccount(vector.task, updated)).state, state);
  }
  const refunded = account();
  refunded.data[233] = 4;
  assert.equal((await verifyEscrowAccount(vector.task, refunded)).state, 'refunded');
  const invalid = account();
  invalid.data[233] = 255;
  await assert.rejects(verifyEscrowAccount(vector.task, invalid), /Invalid escrow state/);
});

test('funding time is bound to the quote and cannot use unsafe or negative integers', async () => {
  for (const time of [BigInt(vector.task.issuedAt - 1), BigInt(vector.task.quoteExpiry), -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
    const changed = account();
    const bytes = Buffer.from(changed.data);
    bytes.writeBigInt64LE(time, 193);
    changed.data = bytes;
    await assert.rejects(verifyEscrowAccount(vector.task, changed));
  }
});
