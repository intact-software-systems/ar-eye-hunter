export {
  type ClientMutationIdempotencyRecord,
  type ClientPrincipalSnapshotRead,
  type ClientStateRepositoryOptions,
  ClientStateRepository,
  ClientStateRepositoryInvariantCorruptionError,
  createTransactionBoundClientStateRepository,
} from '../client-state/persistence/client-state-repository.ts';
