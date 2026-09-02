import {
    validateAppInboxComputedData,
    validateAppInboxComputedProjection
} from '../../../app-inbox/handler/app-inbox-computed-validation.ts';
import { computeAppOutboxInsert } from '../../../app-outbox/app-outbox-insert.ts';
import { computeClientStateSyncEntries } from '../../../state-sync/state-sync-entry-computation.ts';
import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead
} from '../client-mutation-contracts.ts';
import {
    validateClientMutationCommand,
    validateClientMutationFacts
} from '../command-validation/validate-client-mutation-command.ts';
import {
    // Authority policy remains a direct dependency on its canonical owner.
    validateClientMutationAuthorityPolicy
} from './validate-client-mutation-authority-policy.ts';
import { validateClientMutationRead } from './validate-client-mutation-read.ts';
import { validateClientMutationResult } from './validate-client-mutation-result.ts';

export class ClientMutationIdempotencyConflictError extends Error {
    readonly code = 'client-mutation-idempotency-conflict';
    readonly status = 409;

    readonly commandId: string;
    readonly existingCommandHash: string;
    readonly receivedCommandHash: string;

    constructor(
        commandId: string,
        existingCommandHash: string,
        receivedCommandHash: string
    ) {
        super(`Client mutation command differs for request ${commandId}`);
        this.commandId = commandId;
        this.existingCommandHash = existingCommandHash;
        this.receivedCommandHash = receivedCommandHash;
        this.name = 'ClientMutationIdempotencyConflictError';
    }
}

export function validateClientMutation(
    input: Readonly<{
        command: ClientMutationCommand;
        read: ClientMutationRead;
        computed: ClientMutationComputed;
    }>
): void {
    const { command, read, computed } = input;
    validateClientMutationCommand(command);
    validateClientMutationFacts(command.facts);
    const issues = validateAppInboxComputedData(computed, 'computed');
    if (issues.length > 0) {
        throw new ClientMutationRejectedError(issues[0].message);
    }
    validateClientMutationResult(computed);
    validateClientMutationIdentity(command);
    validateClientMutationRead(command, read);
    validateClientMutationAuthorityPolicy(command, read);
    validateClientSessionIdentity(command);
    if (computed.outcome === 'idempotency-conflict') {
        throw new ClientMutationIdempotencyConflictError(
            command.commandId,
            computed.existingCommandHash,
            computed.receivedCommandHash
        );
    }
    validateClientMutationReceiptIdentity(command, computed);
    if (computed.outcome !== 'write') {
        return;
    }
    validateEffectfulClientMutation(command, read, computed);
}

function validateClientMutationIdentity(command: ClientMutationCommand): void {
    if (!/^sha256:[0-9a-f]{64}$/.test(command.facts.commandHash)) {
        throw new ClientMutationRejectedError('Invalid canonical client command hash');
    }
    if (
        !command.commandId ||
        !command.aggregateRef.applicationId ||
        !command.aggregateRef.principalId
    ) {
        throw new ClientMutationRejectedError('Invalid client mutation identity');
    }
    if (command.requestId !== null && command.requestId !== command.commandId) {
        throw new ClientMutationRejectedError('Request id must own the command identity');
    }
}

function validateClientSessionIdentity(command: ClientMutationCommand): void {
    if (!('sessionId' in command)) {
        return;
    }
    if (!command.sessionId || !command.clientInstanceId || !command.input.generationId) {
        throw new ClientMutationRejectedError('Invalid client session identity');
    }
    if (
        command.input.actorPrincipalId !== null &&
        command.input.actorPrincipalId !== command.aggregateRef.principalId
    ) {
        throw new ClientMutationRejectedError('Client session actor is not authorized');
    }
    if (command.input.actorSessionId !== null && command.input.actorSessionId !== command.sessionId) {
        throw new ClientMutationRejectedError('Client connection identity differs');
    }
}

function validateClientMutationReceiptIdentity(
    command: ClientMutationCommand,
    computed: Exclude<ClientMutationComputed, { outcome: 'idempotency-conflict'; }>
): void {
    if (
        computed.receipt.commandHash !== command.facts.commandHash ||
        computed.receipt.commandId !== command.commandId ||
        !Number.isSafeInteger(computed.receipt.stateRevision) ||
        computed.receipt.stateRevision < 1
    ) {
        throw new ClientMutationRejectedError('Client mutation receipt identity differs');
    }
}

function validateEffectfulClientMutation(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    if (
        computed.receipt.outcome !== 'applied' ||
        computed.event.snapshotVersion !== computed.principal.value.snapshotVersion ||
        computed.snapshot.stateRevision !== computed.receipt.stateRevision ||
        computed.snapshot.principal.snapshotVersion !== computed.receipt.snapshotVersion
    ) {
        throw new ClientMutationRejectedError('Invalid effectful client mutation');
    }
    validateClientMutationOutbox(command, computed);
    validateClientPrincipalGuard(read, computed);
    validateClientSessionGuard(read, computed);
    validateClientInstanceGuard(read, computed);
}

function validateClientMutationOutbox(
    command: ClientMutationCommand,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    const expectedOutboxWrites = computed.stateSync
        .flatMap((stateSync) => computeClientStateSyncEntries(stateSync, command.facts.serviceId))
        .map(computeAppOutboxInsert);
    const outboxIssues = validateAppInboxComputedProjection(
        expectedOutboxWrites,
        computed.outboxWrites,
        'computed.outboxWrites'
    );
    const identityIssues = validateAppInboxComputedProjection(
        expectedOutboxWrites.map((write) => write.entry.key.resourceId),
        computed.receipt.outboxIds,
        'computed.receipt.outboxIds'
    );
    if (outboxIssues.length > 0 || identityIssues.length > 0) {
        throw new ClientMutationRejectedError('Client mutation WS outbox differs');
    }
}

function validateClientPrincipalGuard(
    read: ClientMutationRead,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    if (read.principal && computed.principal.operation !== 'update') {
        throw new ClientMutationRejectedError('Existing principal requires compare-and-set');
    }
    if (!read.principal && computed.principal.operation !== 'insert') {
        throw new ClientMutationRejectedError('New principal requires conditional insert');
    }
    if (
        computed.principal.operation === 'update' &&
        computed.principal.expectedRevision !== read.principal?.entry.revision
    ) {
        throw new ClientMutationRejectedError('Principal compare-and-set revision differs');
    }
}

function validateClientSessionGuard(
    read: ClientMutationRead,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    if (computed.session.operation === 'none') {
        return;
    }
    const session = computed.session.value;
    if (
        !session.generationId ||
        !Number.isSafeInteger(session.generationVersion) ||
        session.generationVersion < 1
    ) {
        throw new ClientMutationRejectedError('Invalid client session generation');
    }
    const expectedSessionRevision = read.session?.entry.revision ?? read.expiredSessionEntry?.revision;
    if (
        (computed.session.operation === 'insert' && expectedSessionRevision !== undefined) ||
        (computed.session.operation === 'update' &&
            computed.session.expectedRevision !== expectedSessionRevision)
    ) {
        throw new ClientMutationRejectedError('Client session guard differs');
    }
    const expectedGenerationVersion = read.session
        ? read.session.value.generationId === session.generationId
            ? read.session.value.generationVersion
            : read.session.value.generationVersion + 1
        : 1;
    if (session.generationVersion !== expectedGenerationVersion) {
        throw new ClientMutationRejectedError('Client session generation is not causal');
    }
}

function validateClientInstanceGuard(
    read: ClientMutationRead,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    if (
        (computed.instance.operation === 'insert' && read.instance) ||
        (computed.instance.operation === 'update' &&
            (!read.instance || computed.instance.expectedRevision !== read.instance.entry.revision))
    ) {
        throw new ClientMutationRejectedError('Client instance guard differs');
    }
}
