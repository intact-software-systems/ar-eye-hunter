import {
    byteLengthOfRallarCrdtJson,
    hashRallarCrdtUpdateEnvelope,
    validateRallarCrdtUpdateEnvelope,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtTrustedAppendMetadata
} from '@shared/crdt/mod.ts';

import {
    computeCrdtErase,
    computeCrdtLifecycleUpdate,
    computeCrdtProjectionRebuild,
    computeCrdtSnapshotCompact
} from './compute-crdt-administration.ts';
import {
    computeCrdtAcceptedAppendOutcome,
    computeCrdtRejectedOutcome,
    computeCrdtReplayOutcome
} from './compute-crdt-mutation-outcome.ts';
import type {
    CrdtAppendCommand,
    CrdtMutationAttemptFacts,
    CrdtMutationComputed,
    CrdtMutationRead
} from './crdt-mutation-contracts.ts';

export interface ComputeCrdtMutationInput extends CrdtMutationAttemptFacts {
    readonly serviceId: string;
}

interface NextAppendDocumentInput {
    readonly command: CrdtAppendCommand;
    readonly read: CrdtMutationRead;
    readonly appendSequence: number;
    readonly updateBytes: number;
}

export function computeCrdtMutation(input: ComputeCrdtMutationInput): CrdtMutationComputed {
    const { command, read, serviceId } = input;
    if (!read.authorized) {
        return computeCrdtRejectedOutcome({
            command,
            read,
            code: read.authorizationCode === 'allowed' ? 'authorization-denied' : read.authorizationCode,
            serviceId
        });
    }
    if (!read.featureDecision.allowed) {
        return computeCrdtRejectedOutcome({ command, read, code: 'feature-disabled', serviceId });
    }
    switch (command.operation) {
        case 'append':
            return computeCrdtAppend(input);
        case 'rebuild-projection':
            return computeCrdtProjectionRebuild(input);
        case 'compact':
            return computeCrdtSnapshotCompact(input);
        case 'lifecycle':
            return computeCrdtLifecycleUpdate(input);
        case 'erase':
            return computeCrdtErase(input);
    }
}

function computeCrdtAppend(input: ComputeCrdtMutationInput): CrdtMutationComputed {
    const { command, read, serviceId } = input;
    if (command.operation !== 'append') {
        throw new TypeError('CRDT append computation requires an append command');
    }
    const validation = validateRallarCrdtUpdateEnvelope(command.update);
    if (!validation.valid) {
        return computeCrdtRejectedOutcome({ command, read, code: 'invalid-update', serviceId });
    }
    const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
    if (read.existingUpdate) {
        const code = hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
            ? null
            : 'duplicate-hash-mismatch';
        return code === null
            ? computeCrdtReplayOutcome({ command, read, serviceId })
            : computeCrdtRejectedOutcome({ command, read, code, serviceId });
    }
    if (read.document && read.document.lifecycle !== 'active') {
        return computeCrdtRejectedOutcome({
            command,
            read,
            code: `document-${read.document.lifecycle}`,
            serviceId
        });
    }
    const updateBytes = byteLengthOfRallarCrdtJson(command.update);
    const quota = read.document?.quota ?? read.featureDecision.policy?.quota;
    if (
        quota?.maxUpdateCount !== undefined &&
        (read.document?.updateCount ?? 0) >= quota.maxUpdateCount
    ) {
        return computeCrdtRejectedOutcome({ command, read, code: 'quota-exceeded', serviceId });
    }
    if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
        return computeCrdtRejectedOutcome({ command, read, code: 'update-too-large', serviceId });
    }
    if (
        quota?.maxDocumentBytes !== undefined &&
        (read.document?.storedUpdateBytes ?? 0) + read.storedSnapshotBytes + updateBytes >
            quota.maxDocumentBytes
    ) {
        return computeCrdtRejectedOutcome({ command, read, code: 'quota-exceeded', serviceId });
    }
    if (
        quota?.maxUpdatesPerMinutePerActor !== undefined &&
        read.actorUpdatesInWindow >= quota.maxUpdatesPerMinutePerActor
    ) {
        return computeCrdtRejectedOutcome({ command, read, code: 'rate-limited', serviceId });
    }
    const appendSequence = (read.document?.lastAppendSequence ?? 0) + 1;
    const append: RallarCrdtTrustedAppendMetadata = {
        appendSequence,
        acceptedAtEpochMs: command.capturedAtEpochMs,
        actorId: command.actor.actorId,
        principalId: command.actor.principalId,
        sessionId: command.actor.sessionId,
        serverId: command.actor.serverId,
        authorizationScope: command.authorizationScope,
        acceptedUpdateHash: candidateHash
    };
    const document = nextAppendDocument({ command, read, appendSequence, updateBytes });
    return computeCrdtAcceptedAppendOutcome({ command, read, document, append, serviceId });
}

function nextAppendDocument(input: NextAppendDocumentInput): RallarCrdtDocumentMetadata {
    const { command, read, appendSequence, updateBytes } = input;
    const current = read.document;
    if (current) {
        return {
            ...current,
            documentRevision: current.documentRevision + 1,
            updatedAtEpochMs: command.capturedAtEpochMs,
            lastAppendSequence: appendSequence,
            updateCount: current.updateCount + 1,
            storedUpdateBytes: current.storedUpdateBytes + updateBytes
        };
    }
    return {
        document: command.document,
        documentKey: command.documentKey,
        documentRevision: 1,
        lifecycle: 'active',
        createdAtEpochMs: command.capturedAtEpochMs,
        updatedAtEpochMs: command.capturedAtEpochMs,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 1,
        updateCount: 1,
        snapshotCount: 0,
        storedUpdateBytes: updateBytes,
        retention: read.featureDecision.policy?.retention ?? null,
        quota: read.featureDecision.policy?.quota ?? null,
        projectionIds: []
    };
}
