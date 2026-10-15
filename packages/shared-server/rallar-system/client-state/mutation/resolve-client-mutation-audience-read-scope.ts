import type { ClientMutationCommand, ClientMutationRead } from './client-mutation-contracts.ts';
import { resolveClientSessionHeartbeatDecision } from './compute/compute-client-session-heartbeat.ts';

/**
 * Which audience the read loads for a mutation: the principal's co-member groups and clients, only the
 * principal's own sessions (a heartbeat renewal changes nothing a co-member reads; the principal snapshot
 * already holds them), or nothing because compute cannot produce a write from this read. The read, compute,
 * and validate phases share this one decision.
 */
export type ClientMutationAudienceReadScope = 'principal-audience' | 'own-sessions' | 'none';

export function resolveClientMutationAudienceReadScope(
    command: ClientMutationCommand,
    read: Pick<ClientMutationRead, 'idempotency' | 'session'>
): ClientMutationAudienceReadScope {
    if (read.idempotency) {
        return 'none';
    }
    if (command.operation !== 'heartbeatSession') {
        return 'principal-audience';
    }
    if (!read.session) {
        return 'none';
    }
    return resolveClientSessionHeartbeatDecision(read.session.value, command) === 'renew'
        ? 'own-sessions'
        : 'none';
}
