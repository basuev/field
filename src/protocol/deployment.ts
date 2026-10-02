import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { z } from 'zod';
import { sha256 } from './encoding';
import { ESCROW_PROGRAM_ID } from './escrow';
import { DEVNET_GENESIS } from '../wallet/config';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const manifestSchema = z.strictObject({
  network: z.literal('solana:devnet'), genesis: z.literal(DEVNET_GENESIS), program: z.literal(ESCROW_PROGRAM_ID.toBase58()),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), byteLength: z.number().int().positive().max(2_000_000),
  upgradeAuthority: z.string().min(32).max(44),
});
export type ProgramManifest = z.infer<typeof manifestSchema>;

export async function verifyDeployment(rpc: Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfoAndContext'>, input: unknown): Promise<ProgramManifest> {
  const manifest = manifestSchema.parse(input);
  if (await rpc.getGenesisHash() !== DEVNET_GENESIS) throw new Error('This operation requires Solana devnet');
  const [dataAddress] = PublicKey.findProgramAddressSync([ESCROW_PROGRAM_ID.toBuffer()], LOADER);
  const result = await rpc.getMultipleAccountsInfoAndContext([ESCROW_PROGRAM_ID, dataAddress], { commitment: 'finalized' });
  const [program, account] = result.value;
  if (!program?.executable || !program.owner.equals(LOADER) || program.data.length !== 36
    || program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4)).equals(dataAddress)
    || !account || account.executable || !account.owner.equals(LOADER)) throw new Error('The approved upgradeable program is not deployed');
  const data = Buffer.from(account.data);
  if (data.length < 45 + manifest.byteLength || data.readUInt32LE(0) !== 3 || data[12] !== 1
    || new PublicKey(data.subarray(13, 45)).toBase58() !== manifest.upgradeAuthority
    || await sha256(data.subarray(45, 45 + manifest.byteLength)) !== manifest.sha256
    || data.subarray(45 + manifest.byteLength).some(byte => byte !== 0)) throw new Error('Deployed code or upgrade authority differs from the approved program');
  return manifest;
}
