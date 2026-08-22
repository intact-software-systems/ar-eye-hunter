export {
    materializeGroupStateAuthorityGuard
} from '../group-state/persistence/group-aggregate-repository.ts';
export {
    GroupStateRepositoryInvariantCorruptionError
} from '../group-state/persistence/group-state-persistence-contracts.ts';
export type {
    GroupStateAuthoritativeSnapshot,
    GroupStateAuthorityGuard,
    GroupStateRepositoryOptions
} from '../group-state/persistence/group-state-persistence-contracts.ts';
export {
    createTransactionBoundGroupStateRepository,
    GroupStateRepository
} from '../group-state/persistence/group-state-repository.ts';
