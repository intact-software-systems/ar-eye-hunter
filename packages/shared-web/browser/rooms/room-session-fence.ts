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
    const { clientId, sessionId } = session;
    const isCurrent = (candidate: AuthSession) => candidate.clientId === clientId && candidate.sessionId === sessionId;
    return {
        session,
        assertCurrent: (context) => {
            if (signal?.aborted || context?.serverTime.readWindow().left !== undefined) {
                throw new CommandCancelledError();
            }
            if (
                !isCurrent(requireSession()) ||
                (context && !isCurrent(context.session))
            ) {
                throw new DOMException('Room operation belongs to an obsolete session', 'AbortError');
            }
        }
    };
}
