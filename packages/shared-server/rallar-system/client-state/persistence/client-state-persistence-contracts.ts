import type { ClientPrincipal, ClientSnapshot } from '@shared/api/client-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import type { ClientStateEventStore } from '../../repositories/StateEventStore.ts';

export type ClientStateRepositoryOptions = Readonly<{
  events?: ClientStateEventStore;
}>;

export type ClientPrincipalSnapshotRead = Readonly<{
  principal: RuntimeStateEntryValue<ClientPrincipal>;
  snapshot: ClientSnapshot;
}>;

export type ClientMutationReceipt = Readonly<{
  commandId: string;
  requestId: string | null;
  commandHash: string;
  aggregateRef: import('@shared/api/client-types.ts').ClientPrincipalRef;
  outcome: 'applied' | 'no-op';
  attemptCount: number;
  acceptedStorageRevision: number | null;
  stateRevision: number;
  snapshotVersion: number;
  presenceVersion: number;
  eventId: string | null;
  outboxIds: readonly string[];
}>;

export type ClientMutationIdempotencyRecord = Readonly<{
  requestId: string;
  commandHash: string;
  receipt: ClientMutationReceipt;
}>;

export class ClientStateRepositoryInvariantCorruptionError extends Error {
  readonly code = 'client-state-repository-invariant-corruption';

  constructor(
    readonly storageKey: string,
    message: string,
  ) {
    super(`${message}: ${storageKey}`);
    this.name = 'ClientStateRepositoryInvariantCorruptionError';
  }
}

export async function toLiveClientStateEntryValue<T>(
  entry: RuntimeStateEntry,
): Promise<RuntimeStateEntryValue<T> | undefined> {
  if (entry.expireAtTimestamp <= Date.now()) {
    return undefined;
  }
  try {
    return { entry, value: JSON.parse(entry.value) as T };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ClientStateRepositoryInvariantCorruptionError(
        entry.key,
        `Stored client-state JSON is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

export function withClientStateRepositoryInvariantError<T>(storageKey: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ClientStateRepositoryInvariantCorruptionError) {
      throw error;
    }
    throw new ClientStateRepositoryInvariantCorruptionError(
      storageKey,
      error instanceof Error ? error.message : 'Stored client-state value is invalid',
    );
  }
}
