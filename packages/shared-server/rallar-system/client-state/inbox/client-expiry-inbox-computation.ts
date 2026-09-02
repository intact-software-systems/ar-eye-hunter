import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    computeAppInboxCompletion,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { StateSnapshotReadConflictError } from '../../state-events/state-snapshot-read.ts';
import {
    requiresClientWrite,
    toClientStateWritten,
    type ClientStateWritten
} from '../client-state-service-contracts.ts';
import type { ClientMutationComputed, ClientMutationRead } from '../mutation/client-mutation-contracts.ts';
import { clientStatePrincipalStorageKey } from '../persistence/client-state-principal-storage-key.ts';
import {
    computeClientInboxMutation,
    validateClientInboxWrites,
    type ClientInboxMutationRead,
    type ClientStateInboxComputed,
    type ClientStateInboxValidationIssue
} from './client-state-inbox-computation.ts';

export interface ClientExpiryMutationComputed {
    readonly read: ClientInboxMutationRead;
    readonly predecessor: ClientMutationRead;
    readonly computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>;
}

export interface ClientExpiryInboxRead {
    readonly mutations: readonly ClientInboxMutationRead[];
    readonly completionFacts: AppInboxCompletionFacts;
}

export function computeClientExpiryMutation(
    read: ClientInboxMutationRead,
    previous: ClientExpiryMutationComputed | undefined
): ClientExpiryMutationComputed {
    const predecessor = computeClientExpiryPredecessor(read, previous).fold(
        (conflict) => {
            throw conflict;
        },
        (value) => value
    );
    return { read, predecessor, computed: computeClientInboxMutation({ command: read.command, read: predecessor }) };
}

export function computeClientExpiryInboxCompletion(
    facts: AppInboxCompletionFacts,
    mutations: readonly ClientExpiryMutationComputed[]
): ClientStateInboxComputed<readonly ClientStateWritten[]> {
    const applied = mutations.map((mutation) => mutation.computed).filter((mutation) => mutation.outcome === 'write');
    return {
        clientWrites: mutations.map((mutation) => mutation.computed).filter(requiresClientWrite),
        lifecycleWrite: undefined,
        completion: computeAppInboxCompletion({
            ...facts,
            status: EntityStatus.COMPLETED,
            durableResult: applied.map(toClientStateWritten)
        }),
        afterCommitResult: { committedSnapshots: applied.map((mutation) => mutation.snapshot) }
    };
}

export function validateClientExpiryInboxCompletion(
    read: ClientExpiryInboxRead,
    computed: ClientStateInboxComputed<readonly ClientStateWritten[]>
): readonly ClientStateInboxValidationIssue[] {
    const expectedMutations: ClientExpiryMutationComputed[] = [];
    const previousByPrincipal = new Map<string, ClientExpiryMutationComputed>();
    for (const mutationRead of read.mutations) {
        const principalKey = clientStatePrincipalStorageKey(mutationRead.command.aggregateRef);
        const expected = computeClientExpiryMutation(mutationRead, previousByPrincipal.get(principalKey));
        expectedMutations.push(expected);
        previousByPrincipal.set(principalKey, expected);
    }
    return validateClientInboxWrites(
        read.completionFacts,
        computeClientExpiryInboxCompletion(read.completionFacts, expectedMutations),
        computed
    );
}

function computeClientExpiryPredecessor(
    current: ClientInboxMutationRead,
    previous: ClientExpiryMutationComputed | undefined
): Either<StateSnapshotReadConflictError, ClientMutationRead> {
    if (!previous) {
        return Either.ofRight(current.read);
    }
    if (
        current.read.principal?.entry.revision !== previous.read.read.principal?.entry.revision ||
        current.read.principal?.entry.value !== previous.read.read.principal?.entry.value
    ) {
        return Either.ofLeft(
            new StateSnapshotReadConflictError(clientStatePrincipalStorageKey(current.command.aggregateRef))
        );
    }
    const computed = previous.computed;
    if (computed.outcome !== 'write' || !current.read.principal) {
        return Either.ofRight({
            ...current.read,
            principal: previous.predecessor.principal,
            snapshot: previous.predecessor.snapshot
        });
    }
    return Either.ofRight({
        ...current.read,
        principal: {
            entry: {
                ...current.read.principal.entry,
                revision: computed.principal.operation === 'update' ? computed.principal.expectedRevision + 1 : 0,
                value: JSON.stringify(computed.principal.value)
            },
            value: computed.principal.value
        },
        snapshot: computed.snapshot
    });
}

