import type { GroupEventType, GroupPresenceSession } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { canConnectGroupPresenceSession, GroupPolicyDeniedError } from '../../../group-policy.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import { requirePositiveSafeInteger } from '../../group-state-validation-primitives.ts';
import {
    compareGenerationOrder,
    validateStoredGeneration
} from '../../persistence/validate-persisted-group-presence.ts';
import { toExpiredAwareInsertCandidate } from '../../presence/group-expired-state-authority.ts';
import {
    assertActive,
    assertAllowed,
    assertPrincipalAuthority,
    isExactlyAdmitted,
    toPolicySnapshot
} from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { computeGroupMutationWriteResult, noOp, requireGroup } from '../group-mutation-result.ts';
import {
    computeConnectPresenceAdmission,
    computeDisconnectPresenceAdmission
} from './compute-group-presence-admission.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export function computeConnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    assertPrincipalAuthority(command, command.input.principalId);
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        throw new GroupMutationRejectedError(
            `Forbidden: active group member required for presence: ${command.input.principalId}`
        );
    }
    assertAllowed(
        canConnectGroupPresenceSession({
            snapshot: toPolicySnapshot(read, facts.nowEpochMs),
            actor: {
                principalId: command.input.principalId,
                sessionId: command.input.actorSessionId ?? undefined
            },
            sessionId: command.sessionId,
            nowEpochMs: facts.nowEpochMs
        })
    );
    const existing = read.targetPresence;
    const connection = createConnectedPresenceSession({ command, read, facts });
    if (connection.outcome === 'noop') {
        return noOp(command, read, facts);
    }
    const session = connection.session;
    if (existing && jsonEquals(existing.value, session)) {
        return noOp(command, read, facts);
    }
    const presenceAdmission = computeConnectPresenceAdmission({ command, read, session, facts });
    return presenceWrite({
        command,
        read,
        facts,
        session,
        operation: existing ? 'update' : 'insert',
        eventType: 'session-connected',
        presenceAdmission
    });
}

interface CreateConnectedPresenceSessionInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'connectPresence'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
}

interface PresenceConnectionTiming {
    readonly connectedAt: number;
    readonly heartbeatAt: number;
    readonly expiresAt: number;
    readonly sameGeneration: boolean;
}

type ConnectedPresenceSession =
    | Readonly<{ outcome: 'noop'; }>
    | Readonly<{ outcome: 'session'; session: GroupPresenceSession; }>;

function createConnectedPresenceSession({
    command,
    read,
    facts
}: CreateConnectedPresenceSessionInput): ConnectedPresenceSession {
    const timing = resolvePresenceConnectionTiming({ command, read, facts });
    if (timing === null) {
        return { outcome: 'noop' };
    }
    const existing = read.targetPresence;
    return {
        outcome: 'session',
        session: {
            ...command.aggregateRef,
            sessionId: command.sessionId,
            principalId: command.input.principalId,
            generationId: command.input.generationId,
            generationVersion: timing.connectedAt,
            connectedAtEpochMs: timing.sameGeneration
                ? existing!.value.connectedAtEpochMs
                : timing.connectedAt,
            lastHeartbeatAtEpochMs: timing.sameGeneration
                ? Math.max(existing!.value.lastHeartbeatAtEpochMs, timing.heartbeatAt)
                : timing.heartbeatAt,
            expiresAtEpochMs: timing.sameGeneration
                ? Math.max(existing!.value.expiresAtEpochMs, timing.expiresAt)
                : timing.expiresAt,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }
    };
}

function resolvePresenceConnectionTiming({
    command,
    read,
    facts
}: CreateConnectedPresenceSessionInput): PresenceConnectionTiming | null {
    const existing = read.targetPresence;
    const connectedAt = existing?.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs === null
        ? existing.value.connectedAtEpochMs
        : (command.input.connectedAtEpochMs ?? facts.nowEpochMs);
    requirePositiveSafeInteger(connectedAt, 'Group presence connectedAtEpochMs');
    if (!isPresenceTimestampWithinSkew(connectedAt, facts.nowEpochMs)) {
        throw new GroupMutationRejectedError(
            'Group presence connectedAtEpochMs is too far in the future.'
        );
    }
    if (!isConnectGenerationCurrent(command, read, connectedAt)) {
        return null;
    }
    const sameGeneration = existing !== null &&
        existing.value.generationId === command.input.generationId &&
        existing.value.generationVersion === connectedAt;
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (!isPresenceTimestampWithinSkew(heartbeatAt, facts.nowEpochMs)) {
        throw new GroupMutationRejectedError(
            'Group presence lastHeartbeatAtEpochMs is too far in the future.'
        );
    }
    const expiresAt = command.input.expiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS;
    if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence connection timestamps are causally inconsistent.'
        );
    }
    return { connectedAt, heartbeatAt, expiresAt, sameGeneration };
}

function isConnectGenerationCurrent(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence'; }>,
    read: GroupMutationRead,
    connectedAt: number
): boolean {
    const existing = read.targetPresence;
    if (!existing) {
        return true;
    }
    validateStoredGeneration(existing.value);
    if (existing.value.principalId !== command.input.principalId) {
        throw new GroupMutationRejectedError(
            'A presence session cannot be reassigned to another principal.'
        );
    }
    // connectedAt is the durable generation version. The generation id only
    // breaks equal-timestamp ties, so every writer derives the same total order.
    const incomingOrder = [connectedAt, command.input.generationId] as const;
    const currentOrder = [existing.value.generationVersion, existing.value.generationId] as const;
    const order = compareGenerationOrder(incomingOrder, currentOrder);
    if (order < 0) {
        return false;
    }
    if (order === 0 && existing.value.disconnectedAtEpochMs !== null) {
        return false;
    }
    if (
        existing.value.generationId === command.input.generationId &&
        command.input.connectedAtEpochMs !== null &&
        connectedAt !== existing.value.connectedAtEpochMs
    ) {
        throw new GroupMutationRejectedError(
            'A generationId cannot be reused with a different connectedAtEpochMs.'
        );
    }
    return true;
}

export function computeHeartbeatPresence(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const group = requireGroup(read, command.aggregateRef);
    assertActive(group.value, facts.nowEpochMs);
    const existing = read.targetPresence;
    if (!existing) {
        throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    }
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return noOp(command, read, facts);
    }
    if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
        return noOp(command, read, facts);
    }
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        return noOp(command, read, facts);
    }
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (!isPresenceTimestampWithinSkew(heartbeatAt, facts.nowEpochMs)) {
        throw new GroupMutationRejectedError(
            'Group presence lastHeartbeatAtEpochMs is too far in the future.'
        );
    }
    if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    const expiresAt = Math.max(
        existing.value.expiresAtEpochMs,
        command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs
    );
    if (expiresAt < heartbeatAt) {
        throw new GroupMutationRejectedError(
            'Presence heartbeat expiry must not predate the heartbeat.'
        );
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: expiresAt
    };
    if (jsonEquals(existing.value, session)) {
        return noOp(command, read, facts);
    }
    return presenceWrite({
        command,
        read,
        facts,
        session,
        operation: 'update',
        eventType: 'session-heartbeat',
        presenceSummaryWork: isPureLeaseRenewalHeartbeat(command, read, facts) ? 'none' : 'enqueue'
    });
}

/**
 * A pure lease renewal keeps the session row, event, and receipt but must not
 * expand a presence summary: the session is already listed by the stored
 * summary and its lease had not lapsed at read time, so no online/offline
 * transition can be observed. Anything not provably pure — including a
 * lapsed-lease revival — expands as before. Legacy mode never classifies.
 */
export function isPureLeaseRenewalHeartbeat(
    command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): boolean {
    if (facts.formationDamping !== 'damped') {
        return false;
    }
    const existing = read.targetPresence;
    return (
        existing !== null &&
        existing.value.expiresAtEpochMs > facts.nowEpochMs &&
        (read.presenceSummary?.value.activeSessionIds ?? []).includes(command.sessionId)
    );
}

export function computeDisconnectPresence(
    command: Extract<GroupMutationCommand, { operation: 'disconnectPresence'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    requireGroup(read, command.aggregateRef);
    const existing = read.targetPresence;
    if (!existing) {
        if (facts.internalAuthority === 'expiry') {
            return noOp(command, read, facts);
        }
        throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
    }
    assertPresenceAuthority(command, existing.value.principalId, facts);
    if (
        existing.value.generationId !== command.input.generationId ||
        (command.input.generationVersion !== null &&
            existing.value.generationVersion !== command.input.generationVersion) ||
        (command.input.observedExpiresAtEpochMs !== null &&
            existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
        existing.value.disconnectedAtEpochMs !== null
    ) {
        return noOp(command, read, facts);
    }
    const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
    if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
        return noOp(command, read, facts);
    }
    if (facts.internalAuthority === 'expiry') {
        return presenceWrite({
            command,
            read,
            facts,
            session: existing.value,
            operation: 'delete',
            eventType: 'session-disconnected',
            presenceAdmission: computeDisconnectPresenceAdmission({
                read,
                session: existing.value,
                facts
            })
        });
    }
    const session: GroupPresenceSession = {
        ...existing.value,
        status: 'disconnected',
        disconnectedAtEpochMs: disconnectedAt,
        disconnectReason: command.input.reason ?? 'closed'
    };
    return presenceWrite({
        command,
        read,
        facts,
        session,
        operation: 'update',
        eventType: 'session-disconnected',
        presenceAdmission: computeDisconnectPresenceAdmission({
            read,
            session: existing.value,
            facts
        })
    });
}

interface PresenceWriteInput {
    readonly command: Extract<GroupMutationCommand, {
        operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';
    }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly session: GroupPresenceSession;
    readonly operation: 'insert' | 'update' | 'delete';
    readonly eventType: GroupEventType;
    readonly presenceAdmission?: import('../group-mutation-contracts.ts').PresenceAdmissionCandidate | null;
    readonly presenceSummaryWork?: 'enqueue' | 'none';
}

function presenceWrite({
    command,
    read,
    facts,
    session,
    operation,
    eventType,
    presenceAdmission = null,
    presenceSummaryWork = 'enqueue'
}: PresenceWriteInput): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const guard = operation === 'insert'
        ? ({
            kind: 'presence',
            ...toExpiredAwareInsertCandidate(read.expiredTargetPresenceEntry, session)
        } as const)
        : operation === 'update'
        ? ({
            kind: 'presence',
            operation: 'update',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision
        } as const)
        : ({
            kind: 'presence',
            operation: 'delete',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision
        } as const);
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard,
        members: [],
        initialPresenceSummary: null,
        eventType,
        eventGroup: stored.value,
        presenceAdmission,
        presenceSummaryWork
    });
}

function assertPresenceAuthority(
    command: GroupMutationCommand,
    principalId: string,
    facts: GroupMutationFacts
): void {
    if (facts.internalAuthority !== 'none') {
        return;
    }
    assertPrincipalAuthority(command, principalId);
}
