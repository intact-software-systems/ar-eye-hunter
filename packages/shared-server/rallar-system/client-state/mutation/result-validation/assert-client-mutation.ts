import { ClientMutationRejectedError } from '../../validation/client-mutation-rejection.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead
} from '../client-mutation-contracts.ts';
import {
    assertClientMutationCommand,
    assertClientMutationFacts
} from '../command-validation/assert-client-mutation-command.ts';
import { resolveClientMutationAudienceReadScope } from '../resolve-client-mutation-audience-read-scope.ts';
import { assertClientMutationRead } from './assert-client-mutation-read.ts';
import { assertClientMutationResult } from './assert-client-mutation-result.ts';
import { assertClientPersistenceRecords } from './assert-client-persistence.ts';

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

export interface ClientMutationAssertionInput {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly computed: ClientMutationComputed;
}

/** The caller has proved computed equal to a complete recompute; these are the identity and guard invariants. */
export function assertClientMutationInvariants(
    input: ClientMutationAssertionInput
): void {
    const { command, read, computed } = input;
    assertClientMutationCommand(command);
    assertClientMutationFacts(command.facts);
    assertClientMutationResult(computed);
    assertClientMutationIdentity(command);
    assertClientMutationRead(command, read);
    assertClientSessionIdentity(command);
    if (computed.outcome !== 'idempotency-conflict') {
        assertClientMutationReceiptIdentity(command, computed);
        assertClientPersistenceRecords(computed);
        if (computed.outcome === 'write') {
            assertEffectfulClientMutation(command, read, computed);
        }
    }
}

function assertClientMutationIdentity(command: ClientMutationCommand): void {
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

function assertClientSessionIdentity(command: ClientMutationCommand): void {
    if (!('sessionId' in command)) {
        return;
    }
    if (!command.sessionId || !command.clientInstanceId || !command.input.generationId) {
        throw new ClientMutationRejectedError('Invalid client session identity');
    }
}

function assertClientMutationReceiptIdentity(
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

function assertEffectfulClientMutation(
    command: ClientMutationCommand,
    read: ClientMutationRead,
    computed: Extract<ClientMutationComputed, { outcome: 'write'; }>
): void {
    if (resolveClientMutationAudienceReadScope(command, read) !== 'principal-audience') {
        throw new ClientMutationRejectedError('Client mutation write requires the principal audience read');
    }
    if (
        computed.receipt.outcome !== 'applied' ||
        computed.event.snapshotVersion !== computed.principal.value.snapshotVersion ||
        computed.snapshot.stateRevision !== computed.receipt.stateRevision ||
        computed.snapshot.principal.snapshotVersion !== computed.receipt.snapshotVersion
    ) {
        throw new ClientMutationRejectedError('Invalid effectful client mutation');
    }
    assertClientPrincipalGuard(read, computed);
    assertClientSessionGuard(read, computed);
    assertClientInstanceGuard(read, computed);
}

function assertClientPrincipalGuard(
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

function assertClientSessionGuard(
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

function assertClientInstanceGuard(
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
