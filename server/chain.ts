import { Connection } from '@solana/web3.js';
import { DEVNET_GENESIS, DEVNET_RPC } from '../src/wallet/config';
import type { Task } from '../src/protocol/encoding';
import { escrowAddress } from '../src/protocol/escrow';
import { verifyEscrowAccount } from '../src/protocol/state';
import { Store, type ChainObservation, type TaskRow } from './store';

export interface ChainReader { read(task: Task): Promise<ChainObservation | null>; }

export class DevnetChainReader implements ChainReader {
  constructor(private readonly rpc: Pick<Connection, 'getGenesisHash' | 'getAccountInfoAndContext'> = new Connection(DEVNET_RPC, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  })) {}

  async read(task: Task): Promise<ChainObservation | null> {
    if (await this.rpc.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Wrong Solana network');
    const address = escrowAddress(task.requester, task.id);
    const result = await this.rpc.getAccountInfoAndContext(address, { commitment: 'finalized' });
    if (!result.value) return { slot: result.context.slot, snapshot: null };
    const snapshot = await verifyEscrowAccount(task, { ...result.value, address });
    return { slot: result.context.slot, snapshot };
  }
}

export async function reconcile(store: Store, chain: ChainReader, task: TaskRow): Promise<TaskRow> {
  let observation: ChainObservation | null;
  try { observation = await chain.read(task.task); }
  catch { return store.observe(task.id, null, false); }
  return store.observe(task.id, observation);
}

export function startReconciler(store: Store, chain: ChainReader, onError: (error: unknown) => void, interval = 30_000): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const run = async () => {
    try {
      for (const task of await store.pending()) {
        if (stopped) break;
        await reconcile(store, chain, task);
      }
    } catch (error) { onError(error); }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  const tick = () => { active = run(); };
  timer = setTimeout(tick, interval);
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
