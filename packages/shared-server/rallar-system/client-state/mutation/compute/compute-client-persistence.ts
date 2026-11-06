import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { toClientSessionPurgeAfterEpochMs } from '../../../presence/session-expiry.ts';
import { clientStateIdempotencyStorageKey } from '../../persistence/client-state-idempotency-storage-key.ts';
import { clientStateInstanceStorageKey } from '../../persistence/client-state-instance-storage-key.ts';
import { clientStatePrincipalStorageKey } from '../../persistence/client-state-principal-storage-key.ts';
import {
    CLIENT_STATE_IDEMPOTENT_NAMESPACE,
    CLIENT_STATE_INSTANCES_NAMESPACE,
    CLIENT_STATE_PRINCIPALS_NAMESPACE,
    CLIENT_STATE_SESSIONS_NAMESPACE
} from '../../persistence/client-state-runtime-namespaces.ts';
import { clientStateSessionStorageKey } from '../../persistence/client-state-session-storage-key.ts';
import { clientStateWorkspaceStorageKey } from '../../persistence/client-state-workspace-storage-key.ts';
import type {
    ClientMutationDomainWrite,
    ClientMutationFacts,
    ClientMutationPersistence,
    ClientRuntimePersistenceOperation,
    ConditionalCandidate
} from '../client-mutation-contracts.ts';

interface ClientRuntimeInsertInput {
    readonly namespace: string;
    readonly key: string;
    readonly value: object;
    readonly expireAtEpochMs: number;
}

interface ClientRuntimeCandidateInput<T extends object> {
    readonly namespace: string;
    readonly key: string;
    readonly candidate: Exclude<ConditionalCandidate<T>, { operation: 'none'; }>;
    readonly expireAtEpochMs: number;
}

export function computeClientPersistence(
    computed: ClientMutationDomainWrite,
    facts: Pick<ClientMutationFacts, 'disconnectedSessionRetentionMs' | 'expireAtEpochMs'>
): ClientMutationPersistence {
    if (computed.outcome === 'no-op') {
        return {
            runtimeWrites: [runtimeInsert({
                namespace: CLIENT_STATE_IDEMPOTENT_NAMESPACE,
                key: clientStateIdempotencyStorageKey(
                    computed.aggregateRef,
                    computed.idempotency.requestId
                ),
                value: computed.idempotency,
                expireAtEpochMs: facts.expireAtEpochMs
            })],
            eventWrite: null,
            outboxWrites: []
        };
    }

    const runtimeWrites: ClientRuntimePersistenceOperation[] = [runtimeCandidate({
        namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
        key: clientStatePrincipalStorageKey(computed.principal.value),
        candidate: computed.principal,
        expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
    })];
    appendInstanceWrite(runtimeWrites, computed.instance);
    appendSessionWrite(runtimeWrites, computed.session, facts.disconnectedSessionRetentionMs);
    if (computed.idempotency) {
        runtimeWrites.push(runtimeInsert({
            namespace: CLIENT_STATE_IDEMPOTENT_NAMESPACE,
            key: clientStateIdempotencyStorageKey(
                computed.receipt.aggregateRef,
                computed.idempotency.requestId
            ),
            value: computed.idempotency,
            expireAtEpochMs: facts.expireAtEpochMs
        }));
    }
    return {
        runtimeWrites,
        outboxWrites: [...computed.outbox.map(({ write }) => write), ...computed.viewPublication?.outbox ?? []],
        eventWrite: {
            event: computed.event,
            workspaceKey: clientStateWorkspaceStorageKey(computed.event.workspaceId),
            eventJson: JSON.stringify(computed.event)
        }
    };
}

function appendInstanceWrite(
    writes: ClientRuntimePersistenceOperation[],
    candidate: Extract<ClientMutationDomainWrite, { outcome: 'write'; }>['instance']
): void {
    if (candidate.operation === 'none') {
        return;
    }
    writes.push(runtimeCandidate({
        namespace: CLIENT_STATE_INSTANCES_NAMESPACE,
        key: clientStateInstanceStorageKey(candidate.value),
        candidate,
        expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
    }));
}

function appendSessionWrite(
    writes: ClientRuntimePersistenceOperation[],
    candidate: Extract<ClientMutationDomainWrite, { outcome: 'write'; }>['session'],
    disconnectedRetentionMs: number
): void {
    if (candidate.operation === 'none') {
        return;
    }
    writes.push(runtimeCandidate({
        namespace: CLIENT_STATE_SESSIONS_NAMESPACE,
        key: clientStateSessionStorageKey(candidate.value),
        candidate,
        expireAtEpochMs: toClientSessionPurgeAfterEpochMs(candidate.value, disconnectedRetentionMs)
    }));
}

function runtimeCandidate<T extends object>(
    input: ClientRuntimeCandidateInput<T>
): ClientRuntimePersistenceOperation {
    const { namespace, key, candidate, expireAtEpochMs } = input;
    const stored = {
        namespace,
        key,
        value: encodeRuntimeStateJsonValue(candidate.value),
        expireAtIsoTimestamp: new Date(expireAtEpochMs).toISOString()
    };
    return candidate.operation === 'insert'
        ? { ...stored, kind: 'insert', expectedRevision: null }
        : { ...stored, kind: 'update', expectedRevision: candidate.expectedRevision };
}

function runtimeInsert(
    input: ClientRuntimeInsertInput
): ClientRuntimePersistenceOperation {
    return {
        kind: 'insert',
        namespace: input.namespace,
        key: input.key,
        value: encodeRuntimeStateJsonValue(input.value),
        expireAtIsoTimestamp: new Date(input.expireAtEpochMs).toISOString(),
        expectedRevision: null
    };
}
