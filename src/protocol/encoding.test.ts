import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Keypair } from '@solana/web3.js';
import { CRITERIA, encodeReport, encodeTask, hex, reportHash, reportSchema, taskHash, taskSchema, validateReportForTask } from './encoding';
import { acceptInstruction, disputeInstruction, escrowAddress, fundInstruction, refundInstruction, resolveInstruction, submitReportInstruction } from './escrow';

const vector = JSON.parse(await readFile(new URL('../../fixtures/protocol-v1.json', import.meta.url), 'utf8'));
const task = taskSchema.parse(vector.task);
const report = reportSchema.parse(vector.report);

test('canonical task and report match frozen bytes and independent SHA-256 vectors', async () => {
  assert.equal(hex(encodeTask(task)), vector.taskBytesHex);
  assert.equal(hex(encodeReport(report)), vector.reportBytesHex);
  assert.equal(await taskHash(task), vector.taskHash);
  assert.equal(await reportHash(report), vector.reportHash);
  assert.equal(createHash('sha256').update(encodeTask(task)).digest('hex'), vector.taskHash);
  assert.equal(createHash('sha256').update(encodeReport(report)).digest('hex'), vector.reportHash);
});

test('JSON key ordering does not change a canonical commitment', async () => {
  const reverse = Object.fromEntries(Object.entries(task).reverse());
  assert.equal(await taskHash(reverse), vector.taskHash);
  const shuffled = { ...report, observations: Object.fromEntries(Object.entries(report.observations).reverse()) };
  assert.equal(await reportHash(shuffled), vector.reportHash);
});

test('noncanonical text, unknown fields and unsafe numeric values are rejected', () => {
  for (const name of ['Cafe\u0301', ' Cafe', 'Cafe ', '\ud800']) {
    assert.throws(() => encodeTask({ ...task, cafe: { ...task.cafe, name } }));
  }
  for (const priceLamports of ['0', '01', '-1', '1.0', '18446744073709551616', 1_000_000]) {
    assert.throws(() => encodeTask({ ...task, priceLamports }));
  }
  assert.throws(() => encodeTask({ ...task, network: 'solana:mainnet' }));
  assert.throws(() => encodeTask({ ...task, commission: '0' }));
  assert.throws(() => encodeTask({ ...task, quoteExpiry: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => encodeTask({ ...task, reviewDeadline: task.executionDeadline }));
  assert.throws(() => encodeTask({ ...task, executor: task.requester }));
});

test('price, authorities, deployment and every deadline are bound into the task hash', async () => {
  const alternate = Keypair.fromSeed(new Uint8Array(32).fill(10)).publicKey.toBase58();
  for (const field of ['requester', 'executor', 'reviewer', 'escrowProgram'] as const) {
    assert.notEqual(await taskHash({ ...task, [field]: alternate }), vector.taskHash);
  }
  for (const field of ['issuedAt', 'quoteExpiry', 'executionDeadline', 'reviewDeadline', 'resolutionDeadline'] as const) {
    assert.notEqual(await taskHash({ ...task, [field]: task[field] + 1 }), vector.taskHash);
  }
  assert.notEqual(await taskHash({ ...task, priceLamports: '1000001' }), vector.taskHash);
});

test('all four criteria must be attempted and unknown answers need reasons', () => {
  for (const criterion of CRITERIA) {
    const observations = { ...report.observations };
    delete (observations as Partial<typeof observations>)[criterion];
    assert.throws(() => encodeReport({ ...report, observations }));
    assert.throws(() => encodeReport({ ...report, observations: { ...report.observations, [criterion]: { ...report.observations[criterion], attempted: false } } }));
    assert.throws(() => encodeReport({ ...report, observations: { ...report.observations, [criterion]: { ...report.observations[criterion], answer: 'unknown', reason: '' } } }));
  }
});

test('negative findings can fulfill a task and staff Wi-Fi answers do not assert a connection test', async () => {
  assert.equal((await validateReportForTask(report, task)).observations.freeTable.answer, 'no');
  const observations = { ...report.observations, guestWifi: { ...report.observations.guestWifi, answer: 'yes' as const, source: 'staff' as const, reason: '' } };
  assert.equal((await validateReportForTask({ ...report, observations }, task)).observations.guestWifi.source, 'staff');
  assert.throws(() => reportSchema.parse({ ...report, connectivityTestPassed: true }));
});

test('report task hash, identity, executor and observation times must match', async () => {
  await assert.rejects(validateReportForTask({ ...report, taskHash: 'f'.repeat(64) }, task), /does not match/);
  await assert.rejects(validateReportForTask({ ...report, executor: task.requester }, task), /does not match/);
  await assert.rejects(validateReportForTask({ ...report, taskId: crypto.randomUUID() }, task), /does not match/);
  await assert.rejects(validateReportForTask({ ...report, reportedAt: task.executionDeadline }, task), /outside task bounds/);
  await assert.rejects(validateReportForTask({ ...report, observations: { ...report.observations, freeTable: { ...report.observations.freeTable, observedAt: task.issuedAt - 1 } } }, task), /outside task bounds/);
});

test('instruction data and account metas match frozen cross-language vectors', async () => {
  const instructions = {
    fund: await fundInstruction(task), submit_report: await submitReportInstruction(task, vector.reportHash),
    accept_and_release: await acceptInstruction(task, vector.reportHash), open_dispute: await disputeInstruction(task, task.requester),
    resolve_paid: await resolveInstruction(task, true), resolve_refunded: await resolveInstruction(task, false), refund: await refundInstruction(task),
  };
  assert.equal(escrowAddress(task.requester, task.id).toBase58(), vector.escrowAddress);
  for (const [name, instruction] of Object.entries(instructions)) {
    assert.equal(instruction.programId.toBase58(), task.escrowProgram);
    assert.equal(instruction.data.toString('hex'), vector.instructions[name].dataHex);
    assert.deepEqual(instruction.keys.map(key => ({ address: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })), vector.instructions[name].accounts);
  }
});

test('builders reject other deployments, empty report hashes and arbitrary dispute authorities', async () => {
  await assert.rejects(fundInstruction({ ...task, escrowProgram: task.requester }), /different escrow deployment/);
  await assert.rejects(acceptInstruction(task, '0'.repeat(64)), /nonzero SHA-256/);
  await assert.rejects(submitReportInstruction(task, 'a'.repeat(63)), /nonzero SHA-256/);
  await assert.rejects(disputeInstruction(task, task.reviewer), /Only requester or executor/);
});
