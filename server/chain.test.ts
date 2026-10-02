import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { DevnetChainReader } from './chain';
import { DEVNET_GENESIS } from '../src/wallet/config';
import { ESCROW_PROGRAM_ID } from '../src/protocol/escrow';

const vector = JSON.parse(await readFile(new URL('../fixtures/protocol-v1.json', import.meta.url), 'utf8'));

test('backend reader checks devnet genesis before any task account lookup', async () => {
  let queried = false;
  const reader = new DevnetChainReader({
    async getGenesisHash() { return 'another-network'; },
    async getAccountInfoAndContext() { queried = true; throw new Error('Must not query'); },
  });
  await assert.rejects(reader.read(vector.task), /Wrong Solana network/);
  assert.equal(queried, false);
});

test('backend reads finalized account with context slot and full canonical verification', async () => {
  const reader = new DevnetChainReader({
    async getGenesisHash() { return DEVNET_GENESIS; },
    async getAccountInfoAndContext(address, options) {
      assert.equal(address.toBase58(), vector.escrowAddress);
      assert.deepEqual(options, { commitment: 'finalized' });
      return { context: { slot: 123 }, value: { data: Buffer.from(vector.fundedAccountHex, 'hex'), owner: ESCROW_PROGRAM_ID, executable: false, lamports: 10_000_000 } };
    },
  });
  assert.deepEqual(await reader.read(vector.task), { slot: 123, snapshot: { state: 'funded', fundedAt: vector.task.issuedAt + 1, reportHash: null } });
});

test('missing account is absence of evidence while wrong owner fails verification', async () => {
  const absent = new DevnetChainReader({
    async getGenesisHash() { return DEVNET_GENESIS; },
    async getAccountInfoAndContext() { return { context: { slot: 123 }, value: null }; },
  });
  assert.deepEqual(await absent.read(vector.task), { slot: 123, snapshot: null });
  const foreign = new DevnetChainReader({
    async getGenesisHash() { return DEVNET_GENESIS; },
    async getAccountInfoAndContext() {
      return { context: { slot: 123 }, value: { data: Buffer.from(vector.fundedAccountHex, 'hex'), owner: new PublicKey(vector.task.requester), executable: false, lamports: 10_000_000 } };
    },
  });
  await assert.rejects(foreign.read(vector.task), /approved program/);
});
