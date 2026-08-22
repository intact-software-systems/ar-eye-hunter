import type {
    ClientEvent,
    ClientInstance,
    ClientPrincipal,
    ClientSession,
    ClientSnapshot
} from '@shared/api/client-types.ts';
import { computeClientStateSyncEntries, type ComputedClientStateSync } from '../../../state-sync-publisher.ts';
import { ClientMutationRejectedError } from '../../client-state-validation-primitives.ts';
import {
    compareClientStateInstanceStorageKeys,
    compareClientStateSessionStorageKeys
} from '../../persistence/client-state-storage-keys.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead,
    ClientMutationReceipt,
    ConditionalCandidate
} from '../client-mutation-contracts.ts';
import { toClientMutationActor } from './compute-client-mutation-state.ts';

export type AppliedClientMutationInput = Readonly<{
    command: ClientMutationCommand;
    read: ClientMutationRead;
    principal: ClientPrincipal;
    instance: ConditionalCandidate<ClientInstance>;
    session: ConditionalCandidate<ClientSession>;
    eventType: ClientEvent['eventType'];
    clientInstanceId?: string;
    sessionId?: string;
}>;

export function computeClientMutationResult(
    input: AppliedClientMutationInput
): ClientMutationComputed {
    const { command, read, principal, instance, session } = input;
    const { facts } = command;
    const stateRevision = read.principal ? read.principal.entry.revision + 2 : 1;
    const event = toClientEvent(input);
    const snapshot = toComputedClientSnapshot({
        read,
        principal,
        instance,
        session,
        stateRevision
    });
    const stateSync = toClientStateSync(command, snapshot, event);
    const outboxEntries = stateSync.flatMap((computed) =>
        computeClientStateSyncEntries(
            computed,
            facts.serviceId,
            facts.formationDamping === 'damped' ? 'principal' : 'world'
        )
    );
    const receipt = toAppliedClientMutationReceipt({
        command,
        read,
        principal,
        event,
        stateRevision,
        outboxIds: outboxEntries.map((entry) => entry.key.resourceId)
    });
    return {
        outcome: 'write',
        principal: read.principal
            ? { operation: 'update', value: principal, expectedRevision: read.principal.entry.revision }
            : { operation: 'insert', value: principal },
        instance,
        session,
        event,
        snapshot,
        receipt,
        idempotency: command.requestId === null
            ? null
            : { requestId: command.requestId, commandHash: facts.commandHash, receipt },
        stateSync,
        outboxEntries
    };
}

export function computeClientMutationNoOp(
    input: Readonly<{
        command: ClientMutationCommand;
        read: ClientMutationRead;
        persistIdempotency?: boolean;
    }>
): ClientMutationComputed {
    const { command, read, persistIdempotency = true } = input;
    const principal = read.principal?.value;
    if (!principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`
        );
    }
    const receipt = toNoOpClientMutationReceipt(command, read);
    const snapshot = requireClientMutationReadSnapshot(read, command);
    if (persistIdempotency && command.requestId !== null) {
        return {
            outcome: 'no-op',
            persistIdempotency: true,
            aggregateRef: command.aggregateRef,
            idempotency: {
                requestId: command.requestId,
                commandHash: command.facts.commandHash,
                receipt
            },
            receipt,
            snapshot,
            event: null
        };
    }
    return {
        outcome: 'no-op',
        persistIdempotency: false,
        receipt,
        snapshot,
        event: null
    };
}

export function requireClientMutationReadSnapshot(
    read: ClientMutationRead,
    command: ClientMutationCommand
): ClientSnapshot {
    if (!read.snapshot) {
        throw new ClientMutationRejectedError(
            `Client snapshot not found: ${command.aggregateRef.principalId}`
        );
    }
    return read.snapshot;
}

export function assertNeverClientMutationComputed(value: never): never {
    throw new Error(`Unhandled client mutation outcome: ${JSON.stringify(value)}`);
}

function toComputedClientSnapshot(
    input: Readonly<{
        read: ClientMutationRead;
        principal: ClientPrincipal;
        instance: ConditionalCandidate<ClientInstance>;
        session: ConditionalCandidate<ClientSession>;
        stateRevision: number;
    }>
): ClientSnapshot {
    const { read, principal, instance, session, stateRevision } = input;
    const instances = [...(read.snapshot?.instances ?? [])];
    if (instance.operation !== 'none') {
        const index = instances.findIndex(
            (candidate) => candidate.clientInstanceId === instance.value.clientInstanceId
        );
        if (index < 0) {
            instances.push(instance.value);
        }
        else {
            instances[index] = instance.value;
        }
    }
    const activeSessions = [...(read.snapshot?.activeSessions ?? [])];
    applySessionCandidate(activeSessions, session);
    instances.sort(compareClientStateInstanceStorageKeys);
    activeSessions.sort(compareClientStateSessionStorageKeys);
    const lastSeenAtEpochMs = activeSessions.reduce<number | null>(
        (latest, candidate) =>
            latest === null
                ? candidate.lastHeartbeatAtEpochMs
                : Math.max(latest, candidate.lastHeartbeatAtEpochMs),
        principal.lastSeenAtEpochMs
    );
    return {
        stateRevision,
        principal,
        instances,
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs
    };
}

function applySessionCandidate(
    activeSessions: ClientSession[],
    session: ConditionalCandidate<ClientSession>
): void {
    if (session.operation === 'none') {
        return;
    }
    const index = activeSessions.findIndex(
        (candidate) =>
            candidate.clientInstanceId === session.value.clientInstanceId &&
            candidate.sessionId === session.value.sessionId
    );
    const isActive = session.value.status === 'active' && session.value.disconnectedAtEpochMs === null;
    if (isActive && index < 0) {
        activeSessions.push(session.value);
    }
    else if (isActive) {
        activeSessions[index] = session.value;
    }
    else if (index >= 0) {
        activeSessions.splice(index, 1);
    }
}

function toClientStateSync(
    command: ClientMutationCommand,
    snapshot: ClientSnapshot,
    event: ClientEvent
): readonly ComputedClientStateSync[] {
    const common = {
        commandId: command.commandId,
        aggregateRef: command.aggregateRef,
        audience: {
            kind: 'principal' as const,
            applicationId: command.aggregateRef.applicationId,
            workspaceId: command.aggregateRef.workspaceId,
            resourceId: command.aggregateRef.principalId
        },
        createdAtEpochMs: command.facts.nowEpochMs,
        expireAtEpochMs: command.facts.expireAtEpochMs
    };
    return [
        {
            ...common,
            acceptedCausalRevision: snapshot.stateRevision,
            effects: [{ effectKind: 'principal-state', payloadKind: 'snapshot', payload: snapshot }]
        },
        {
            ...common,
            acceptedCausalRevision: event.snapshotVersion,
            effects: [{ effectKind: 'principal-state', payloadKind: 'event', payload: event }]
        }
    ];
}

function toAppliedClientMutationReceipt(
    input: Readonly<{
        command: ClientMutationCommand;
        read: ClientMutationRead;
        principal: ClientPrincipal;
        event: ClientEvent;
        stateRevision: number;
        outboxIds: readonly string[];
    }>
): ClientMutationReceipt {
    const { command, read, principal, event, stateRevision, outboxIds } = input;
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: command.facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: 'applied',
        attemptCount: command.facts.attemptCount,
        acceptedStorageRevision: read.principal ? read.principal.entry.revision + 1 : 0,
        stateRevision,
        snapshotVersion: principal.snapshotVersion,
        presenceVersion: principal.presenceVersion,
        eventId: event.eventId,
        outboxIds
    };
}

function toNoOpClientMutationReceipt(
    command: ClientMutationCommand,
    read: ClientMutationRead
): ClientMutationReceipt {
    const principal = read.principal?.value;
    if (!principal) {
        throw new ClientMutationRejectedError(
            `Client principal not found: ${command.aggregateRef.principalId}`
        );
    }
    return {
        commandId: command.commandId,
        requestId: command.requestId,
        commandHash: command.facts.commandHash,
        aggregateRef: command.aggregateRef,
        outcome: 'no-op',
        attemptCount: command.facts.attemptCount,
        acceptedStorageRevision: read.principal.entry.revision,
        stateRevision: read.principal.entry.revision + 1,
        snapshotVersion: principal.snapshotVersion,
        presenceVersion: principal.presenceVersion,
        eventId: null,
        outboxIds: []
    };
}

function toClientEvent(input: AppliedClientMutationInput): ClientEvent {
    const { command, principal, eventType, clientInstanceId, sessionId } = input;
    return {
        ...command.aggregateRef,
        eventId: command.facts.eventId,
        eventType,
        snapshotVersion: principal.snapshotVersion,
        clientInstanceId: clientInstanceId ?? null,
        sessionId: sessionId ?? null,
        occurredAtEpochMs: command.facts.nowEpochMs,
        actor: toClientMutationActor(command.input, principal, command.facts),
        reason: command.input.reason,
        traceId: command.input.traceId,
        requestId: command.requestId,
        payload: {}
    };
}
