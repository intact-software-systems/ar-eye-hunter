import type { ClientSession } from '@shared/api/client-types.ts';

import { isPresenceTimestampWithinSkew } from '../../../presence/presence-lease.ts';
import { sameClientSessionState } from '../../client-state-semantic-equality.ts';
import { rejectClientMutation } from '../../validation/client-mutation-rejection.ts';
import type {
    ClientMutationCommand,
    ClientMutationComputed,
    ClientMutationRead
} from '../client-mutation-contracts.ts';
import { computeClientMutationNoOp, computeClientMutationResult } from './compute-client-mutation-result.ts';
import {
    bumpClientPrincipal,
    requireClientPrincipal,
    requireClientSession,
    toClientChildCandidate
} from './compute-client-mutation-state.ts';

export type ClientSessionHeartbeatCommand = Extract<ClientMutationCommand, { operation: 'heartbeatSession'; }>;

export type ClientSessionHeartbeatDecision = 'renew' | 'no-op' | 'reject';

export function resolveClientSessionHeartbeatDecision(
    existing: ClientSession,
    command: ClientSessionHeartbeatCommand
): ClientSessionHeartbeatDecision {
    if (
        existing.generationId !== command.input.generationId ||
        existing.status !== 'active' ||
        existing.disconnectedAtEpochMs !== null
    ) {
        return 'no-op';
    }
    const heartbeatAt = toClientSessionHeartbeatAt(command);
    if (!isPresenceTimestampWithinSkew(heartbeatAt, command.facts.nowEpochMs)) {
        return 'reject';
    }
    return heartbeatAt < existing.lastHeartbeatAtEpochMs ? 'no-op' : 'renew';
}

export function computeClientSessionHeartbeat(
    input: Readonly<{ command: ClientSessionHeartbeatCommand; read: ClientMutationRead; }>
): ClientMutationComputed {
    const { command, read } = input;
    const principal = requireClientPrincipal(read, command);
    const existing = requireClientSession(read, command);
    const decision = resolveClientSessionHeartbeatDecision(existing, command);
    if (decision === 'no-op') {
        return computeClientMutationNoOp({ command, read, persistIdempotency: false });
    }
    if (decision === 'reject') {
        rejectClientMutation('Client session lastHeartbeatAtEpochMs is too far in the future.');
    }
    const heartbeatAt = toClientSessionHeartbeatAt(command);
    const session: ClientSession = {
        ...existing,
        presenceState: command.input.presenceState ?? existing.presenceState,
        lastHeartbeatAtEpochMs: heartbeatAt,
        expiresAtEpochMs: Math.max(
            existing.expiresAtEpochMs,
            command.input.expiresAtEpochMs ?? heartbeatAt + 24 * 60 * 60 * 1000
        )
    };
    if (sameClientSessionState(existing, session)) {
        return computeClientMutationNoOp({ command, read });
    }
    const nextPrincipal = bumpClientPrincipal({
        principal,
        mutationInput: command.input,
        facts: command.facts,
        requestId: command.requestId,
        domain: 'presence',
        lastSeenAtEpochMs: heartbeatAt
    });
    return computeClientMutationResult({
        command,
        read,
        principal: nextPrincipal,
        instance: { operation: 'none' },
        session: toClientChildCandidate(read.session, session),
        eventType: 'session-heartbeat',
        clientInstanceId: command.clientInstanceId,
        sessionId: command.sessionId
    });
}

function toClientSessionHeartbeatAt(command: ClientSessionHeartbeatCommand): number {
    return command.input.lastHeartbeatAtEpochMs ?? command.facts.nowEpochMs;
}
