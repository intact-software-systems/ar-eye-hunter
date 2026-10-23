import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { CommandCancelledError } from '@shared/cache/Command.ts';

export interface RoomSessionFence {
    readonly session: AuthSession;
    assertCurrent(context?: ApiMiddleware): void;
}

/** A room operation remains owned by the principal and session that started it. */
export function captureRoomSession(
    requireSession: () => AuthSession,
    signal: AbortSignal | undefined
): RoomSessionFence {
    const session = requireSession();
    return {
        session,
        assertCurrent: (context) => {
            if (signal?.aborted) {
                throw new CommandCancelledError();
            }
            if (
                toAuthSessionKey(requireSession()) !== toAuthSessionKey(session) ||
                (context && toAuthSessionKey(context.session) !== toAuthSessionKey(session))
            ) {
                throw new DOMException('Room operation belongs to an obsolete session', 'AbortError');
            }
        }
    };
}
