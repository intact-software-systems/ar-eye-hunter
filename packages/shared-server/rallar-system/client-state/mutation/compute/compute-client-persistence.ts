import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { encodeRuntimeStateJsonValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { toSessionPurgeAfterEpochMs } from '../../../presence/session-expiry.ts';
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

export function computeClientPersistence(
    computed: ClientMutationDomainWrite
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
                expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
            })],
            eventWrite: null
        };
    }

    const runtimeWrites: ClientRuntimePersistenceOperation[] = [runtimeCandidate(
        CLIENT_STATE_PRINCIPALS_NAMESPACE,
        clientStatePrincipalStorageKey(computed.principal.value),
        computed.principal,
        NEVER_EXPIRE_AT_TIMESTAMP
    )];
    appendInstanceWrite(runtimeWrites, computed.instance);
    appendSessionWrite(runtimeWrites, computed.session);
    if (computed.idempotency) {
        runtimeWrites.push(runtimeInsert({
            namespace: CLIENT_STATE_IDEMPOTENT_NAMESPACE,
            key: clientStateIdempotencyStorageKey(
                computed.receipt.aggregateRef,
                computed.idempotency.requestId
            ),
            value: computed.idempotency,
            expireAtEpochMs: NEVER_EXPIRE_AT_TIMESTAMP
        }));
    }
    return {
        runtimeWrites,
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
    writes.push(runtimeCandidate(
        CLIENT_STATE_INSTANCES_NAMESPACE,
        clientStateInstanceStorageKey(candidate.value),
        candidate,
        NEVER_EXPIRE_AT_TIMESTAMP
    ));
}

function appendSessionWrite(
    writes: ClientRuntimePersistenceOperation[],
    candidate: Extract<ClientMutationDomainWrite, { outcome: 'write'; }>['session']
): void {
    if (candidate.operation === 'none') {
        return;
    }
    writes.push(runtimeCandidate(
        CLIENT_STATE_SESSIONS_NAMESPACE,
        clientStateSessionStorageKey(candidate.value),
        candidate,
        toSessionPurgeAfterEpochMs(
            candidate.value.expiresAtEpochMs,
            candidate.value.disconnectedAtEpochMs
        )
    ));
}

function runtimeCandidate<T extends object>(
    namespace: string,
    key: string,
    candidate: Exclude<ConditionalCandidate<T>, { operation: 'none'; }>,
    expireAtEpochMs: number
): ClientRuntimePersistenceOperation {
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
