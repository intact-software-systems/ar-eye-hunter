import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALSessionInvalidationAuthority } from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';

import type { WsOutboxProvenanceFacts } from '../../../websocket/outbox/ws-outbox-provenance.ts';
import type { LogoutAuthSessionCommand } from '../auth-mutation-contracts.ts';

export function toAuthLogoutProvenanceFacts(
    command: LogoutAuthSessionCommand,
    message: ALMessage
): WsOutboxProvenanceFacts {
    const sessionInvalidation: ALSessionInvalidationAuthority = {
        kind: 'auth-session-invalidation',
        sessionId: command.expected.sessionId,
        requestId: command.requestId,
        invalidatedAtMs: command.capturedAtEpochMs,
        issuedAtMs: command.expected.issuedAtEpochMs,
        expiresAtMs: command.expected.expiresAtEpochMs
    };
    return {
        message,
        producerKind: 'auth-session-invalidation',
        target: {
            kind: 'exact-invalidated-session',
            sessionInvalidation,
            admittedAudience: [sessionInvalidation.sessionId]
        },
        expiresAtMs: sessionInvalidation.expiresAtMs
    };
}
