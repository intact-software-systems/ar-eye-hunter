import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import { validatePositiveSafeInteger, type GroupStateValidationIssue } from '../../group-state-validation-issues.ts';
import {
    compareGenerationOrder,
    validateStoredGenerationValues
} from '../../persistence/validate-persisted-group-presence.ts';
import { canConnectGroupPresenceSession } from '../../policy/group-membership-admission-policy.ts';
import { GroupPolicyDeniedError } from '../../policy/group-policy-result.ts';
import { toPolicySnapshot, validatePrincipalAuthority } from '../aggregate/group-aggregate-mutation-policy.ts';
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
): Either<readonly GroupStateValidationIssue[], GroupMutationComputed> {
    requireGroup(read, command.aggregateRef);
    const issues = [...validatePrincipalAuthority(command, command.input.principalId)];
    const member = read.targetMember ?? undefined;
    if (!member || member.status !== 'active') {
        issues.push({
            path: 'read.targetMember',
            cause: new GroupMutationRejectedError(
                `Forbidden: active group member required for presence: ${command.input.principalId}`
            )
        });
    }
    const permission = canConnectGroupPresenceSession({
        snapshot: toPolicySnapshot(read, command.aggregateRef, facts.nowEpochMs),
        actor: {
            principalId: command.input.principalId,
            sessionId: command.input.actorSessionId ?? undefined
        },
        sessionId: command.sessionId,
        nowEpochMs: facts.nowEpochMs
    });
    if (!permission.allowed) {
        issues.push({ path: 'read', cause: new GroupPolicyDeniedError(permission) });
    }
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const existing = read.targetPresence;
    const connection = computeConnectedPresenceSession({ command, read, facts });
    if (connection.left !== undefined) {
        return Either.ofLeft(connection.left);
    }
    if (connection.right!.outcome === 'noop') {
        return Either.ofRight(noOp(command, read, facts));
    }
    const session = connection.right!.session;
    if (existing && jsonEquals(existing.value, session)) {
        return Either.ofRight(noOp(command, read, facts));
    }
    const presenceAdmission = computeConnectPresenceAdmission({ command, read, session, facts });
    if (presenceAdmission.left !== undefined) {
        return Either.ofLeft(presenceAdmission.left);
    }
    return Either.ofRight(computeGroupPresenceWrite({
        command,
        read,
        facts,
        session,
        operation: existing ? 'update' : 'insert',
        eventType: 'session-connected',
        presenceAdmission: presenceAdmission.right!
    }));
}

interface ComputeConnectedPresenceSessionInput {
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

function computeConnectedPresenceSession({
    command,
    read,
    facts
}: ComputeConnectedPresenceSessionInput): Either<readonly GroupStateValidationIssue[], ConnectedPresenceSession> {
    const decision = computePresenceConnectionTiming({ command, read, facts });
    if (decision.left !== undefined) {
        return Either.ofLeft(decision.left);
    }
    const timing = decision.right!;
    if (timing === null) {
        return Either.ofRight({ outcome: 'noop' });
    }
    const existing = read.targetPresence;
    const existingSession = timing.sameGeneration
        ? requireExistingPresenceSession(existing?.value)
        : null;
    return Either.ofRight({
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
    });
}

function requireExistingPresenceSession(
    session: GroupPresenceSession | undefined
): GroupPresenceSession {
    if (session === undefined) {
        throw new TypeError('Same-generation group presence is missing its predecessor');
    }
    return session;
}

function computePresenceConnectionTiming({
    command,
    read,
    facts
}: ComputeConnectedPresenceSessionInput): Either<
    readonly GroupStateValidationIssue[],
    PresenceConnectionTiming | null
> {
    const existing = read.targetPresence;
    const connectedAt = existing?.value.generationId === command.input.generationId &&
            command.input.connectedAtEpochMs === null
        ? existing.value.connectedAtEpochMs
        : (command.input.connectedAtEpochMs ?? facts.nowEpochMs);
    const issues = [...validatePositiveSafeInteger(connectedAt, 'Group presence connectedAtEpochMs')];
    if (!isPresenceTimestampWithinSkew(connectedAt, facts.nowEpochMs)) {
        issues.push({
            path: 'read.targetPresence.connectedAtEpochMs',
            cause: new GroupMutationRejectedError(
                'Group presence connectedAtEpochMs is too far in the future.'
            )
        });
    }
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    const generation = computeConnectGenerationCurrent(command, read, connectedAt);
    if (generation.left !== undefined) {
        return Either.ofLeft(generation.left);
    }
    if (!generation.right) {
        return Either.ofRight(null);
    }
    const sameGeneration = existing !== null &&
        existing.value.generationId === command.input.generationId &&
        existing.value.generationVersion === connectedAt;
    const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
    if (!isPresenceTimestampWithinSkew(heartbeatAt, facts.nowEpochMs)) {
        issues.push({
            path: 'command.input.lastHeartbeatAtEpochMs',
            cause: new GroupMutationRejectedError(
                'Group presence lastHeartbeatAtEpochMs is too far in the future.'
            )
        });
    }
    const expiresAt = command.input.expiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS;
    if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
        issues.push({
            path: 'command.input',
            cause: new GroupMutationRejectedError(
                'Presence connection timestamps are causally inconsistent.'
            )
        });
    }
    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ connectedAt, heartbeatAt, expiresAt, sameGeneration });
}

function computeConnectGenerationCurrent(
    command: Extract<GroupMutationCommand, { operation: 'connectPresence'; }>,
    read: GroupMutationRead,
    connectedAt: number
): Either<readonly GroupStateValidationIssue[], boolean> {
    const existing = read.targetPresence;
    if (!existing) {
        return Either.ofRight(true);
    }
    const generationIssues = validateStoredGenerationValues(
        existing.value.connectedAtEpochMs,
        existing.value.generationVersion
    );
    if (generationIssues.length > 0) {
        return Either.ofLeft(generationIssues);
    }
    if (existing.value.principalId !== command.input.principalId) {
        return Either.ofLeft([{
            path: 'read.targetPresence.principalId',
            cause: new GroupMutationRejectedError(
                'A presence session cannot be reassigned to another principal.'
            )
        }]);
    }
    // connectedAt is the durable generation version. The generation id only
    // breaks equal-timestamp ties, so every writer derives the same total order.
    const incomingOrder = [connectedAt, command.input.generationId] as const;
    const currentOrder = [existing.value.generationVersion, existing.value.generationId] as const;
    const order = compareGenerationOrder(incomingOrder, currentOrder);
    if (order < 0) {
        return Either.ofRight(false);
    }
    if (order === 0 && existing.value.disconnectedAtEpochMs !== null) {
        return Either.ofRight(false);
    }
    if (
        existing.value.generationId === command.input.generationId &&
        command.input.connectedAtEpochMs !== null &&
        connectedAt !== existing.value.connectedAtEpochMs
    ) {
        return Either.ofLeft([{
            path: 'command.input.generationId',
            cause: new GroupMutationRejectedError(
                'A generationId cannot be reused with a different connectedAtEpochMs.'
            )
        }]);
    }
    return Either.ofRight(true);
}
