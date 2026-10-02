import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export const CRITERIA = ['freeTable', 'laptopAllowed', 'guestWifi', 'outlet'] as const;
const MAX_U64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();

function text(max: number) {
  return z.string().max(max).refine(value => value === value.normalize('NFC') && value === value.trim()
    && new TextDecoder().decode(encoder.encode(value)) === value, 'Text must be trimmed, NFC and valid Unicode');
}

const address = z.string().refine(value => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Expected a canonical public key');
const publicKey = address.refine(value => {
  try { return PublicKey.isOnCurve(new PublicKey(value).toBytes()); } catch { return false; }
}, 'Expected a signing-wallet public key');
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const taskId = z.uuid().regex(/^[0-9a-f-]+$/).refine(value => value !== '00000000-0000-0000-0000-000000000000');
const commitment = z.string().regex(/^[0-9a-f]{64}$/).refine(value => value !== '0'.repeat(64));
const amount = z.string().max(20).regex(/^[1-9][0-9]*$/)
  .refine(value => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_U64, 'Amount exceeds u64');

export const taskSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: taskId,
  kind: z.literal('cafe-laptop-check'),
  network: z.literal('solana:devnet'),
  escrowProgram: address,
  cafe: z.strictObject({ name: text(200).min(1), address: text(500).min(1) }),
  requester: publicKey, executor: publicKey, reviewer: publicKey,
  priceLamports: amount,
  issuedAt: timestamp,
  quoteExpiry: timestamp,
  executionDeadline: timestamp,
  reviewDeadline: timestamp,
  resolutionDeadline: timestamp,
}).refine(task => task.issuedAt < task.quoteExpiry && task.quoteExpiry <= task.executionDeadline
  && task.executionDeadline < task.reviewDeadline && task.reviewDeadline < task.resolutionDeadline,
  'Invalid absolute deadlines')
  .refine(task => new Set([task.requester, task.executor, task.reviewer]).size === 3, 'Roles require distinct wallets');

const observationSchema = z.strictObject({
  attempted: z.literal(true),
  answer: z.enum(['yes', 'no', 'unknown']),
  source: z.enum(['observation', 'staff', 'unavailable']),
  observedAt: timestamp,
  reason: text(1000),
}).refine(observation => observation.answer === 'unknown' ? observation.reason.length > 0 : observation.reason.length === 0,
  'An unknown answer requires a reason, an answered criterion has no missing-answer reason')
  .refine(observation => observation.source !== 'unavailable' || observation.answer === 'unknown', 'Unavailable source cannot establish an answer');

export const reportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId,
  taskHash: commitment,
  executor: publicKey,
  reportedAt: timestamp,
  observations: z.strictObject({
    freeTable: observationSchema, laptopAllowed: observationSchema,
    guestWifi: observationSchema, outlet: observationSchema,
  }),
  notes: text(2000),
}).refine(report => CRITERIA.every(criterion => report.observations[criterion].observedAt <= report.reportedAt),
  'Observation cannot follow report creation');

export type Task = z.infer<typeof taskSchema>;
export type Report = z.infer<typeof reportSchema>;

class Writer {
  private readonly parts: Uint8Array[] = [];
  bytes(value: Uint8Array) { this.parts.push(value); }
  byte(value: number) { this.bytes(Uint8Array.of(value)); }
  u64(value: number | bigint) {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setBigUint64(0, BigInt(value), true);
    this.bytes(new Uint8Array(buffer));
  }
  string(value: string) {
    const bytes = encoder.encode(value);
    const length = new ArrayBuffer(4);
    new DataView(length).setUint32(0, bytes.length, true);
    this.bytes(new Uint8Array(length));
    this.bytes(bytes);
  }
  finish() {
    const output = new Uint8Array(this.parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of this.parts) { output.set(part, offset); offset += part.length; }
    return output;
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Expected lowercase byte-aligned hexadecimal');
  return Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16));
}

export function encodeTask(input: unknown): Uint8Array {
  const task = taskSchema.parse(input);
  const writer = new Writer();
  writer.bytes(encoder.encode('Field/task/v1\0'));
  writer.string(task.network);
  writer.bytes(new PublicKey(task.escrowProgram).toBytes());
  writer.bytes(unhex(task.id.replaceAll('-', '')));
  for (const key of [task.requester, task.executor, task.reviewer]) writer.bytes(new PublicKey(key).toBytes());
  writer.u64(BigInt(task.priceLamports));
  for (const time of [task.issuedAt, task.quoteExpiry, task.executionDeadline, task.reviewDeadline, task.resolutionDeadline]) writer.u64(time);
  writer.string(task.cafe.name);
  writer.string(task.cafe.address);
  return writer.finish();
}

export function encodeReport(input: unknown): Uint8Array {
  const report = reportSchema.parse(input);
  const writer = new Writer();
  writer.bytes(encoder.encode('Field/report/v1\0'));
  writer.bytes(unhex(report.taskId.replaceAll('-', '')));
  writer.bytes(unhex(report.taskHash));
  writer.bytes(new PublicKey(report.executor).toBytes());
  writer.u64(report.reportedAt);
  for (const criterion of CRITERIA) {
    const observation = report.observations[criterion];
    writer.byte(1);
    writer.byte(['yes', 'no', 'unknown'].indexOf(observation.answer));
    writer.byte(['observation', 'staff', 'unavailable'].indexOf(observation.source));
    writer.u64(observation.observedAt);
    writer.string(observation.reason);
  }
  writer.string(report.notes);
  return writer.finish();
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

export async function taskHash(input: unknown): Promise<string> { return sha256(encodeTask(input)); }
export async function reportHash(input: unknown): Promise<string> { return sha256(encodeReport(input)); }

export async function validateReportForTask(input: unknown, taskInput: unknown): Promise<Report> {
  const task = taskSchema.parse(taskInput);
  const report = reportSchema.parse(input);
  if (report.taskId !== task.id || report.taskHash !== await taskHash(task) || report.executor !== task.executor) {
    throw new Error('Report does not match the funded task and executor');
  }
  if (report.reportedAt < task.issuedAt || report.reportedAt >= task.executionDeadline
    || CRITERIA.some(criterion => report.observations[criterion].observedAt < task.issuedAt)) {
    throw new Error('Report observation or creation time is outside task bounds');
  }
  return report;
}
