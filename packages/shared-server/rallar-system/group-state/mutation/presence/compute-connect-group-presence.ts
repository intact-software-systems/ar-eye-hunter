import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import { requirePositiveSafeInteger } from '../../group-state-validation-primitives.ts';
import {
    compareGenerationOrder,
    validateStoredGeneration
} from '../../persistence/validate-persisted-group-presence.ts';
import { canConnectGroupPresenceSession } from '../../policy/group-membership-admission-policy.ts';
import {
    assertAllowed,
    assertPrincipalAuthority,
    toPolicySnapshot
} from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead
} from '../group-mutation-contracts.ts';
import { GroupMutationRejectedError } from '../group-mutation-contracts.ts';
import { noOp, requireGroup } from '../group-mutation-result.ts';
import { computeConnectPresenceAdmission } from './compute-group-presence-admission.ts';
import { computeGroupPresenceWrite } from './compute-group-presence-write.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export function computeConnectGroupPresence(
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
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
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
    return computeGroupPresenceWrite({
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
    const existingSession = timing.sameGeneration
        ? requireExistingPresenceSession(existing?.value)
        : null;
    return {
        outcome: 'session',
        session: {
            ...command.aggregateRef,
            sessionId: command.sessionId,
            principalId: command.input.principalId,
            generationId: command.input.generationId,
            generationVersion: timing.connectedAt,
            connectedAtEpochMs: existingSession?.connectedAtEpochMs ?? timing.connectedAt,
            lastHeartbeatAtEpochMs: existingSession
                ? Math.max(existingSession.lastHeartbeatAtEpochMs, timing.heartbeatAt)
                : timing.heartbeatAt,
            expiresAtEpochMs: existingSession
                ? Math.max(existingSession.expiresAtEpochMs, timing.expiresAt)
                : timing.expiresAt,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }
    };
}

function requireExistingPresenceSession(
    session: GroupPresenceSession | undefined
): GroupPresenceSession {
    if (session === undefined) {
        throw new TypeError('Same-generation group presence is missing its predecessor');
    }
    return session;
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
