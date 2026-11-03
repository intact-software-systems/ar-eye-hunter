import type { RallarOnChangeOptions } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarAuthChangeListener, RallarAuthState } from '@shared-web/browser/session/rallar-auth-facade.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';

/** Bridges the app's explicit API session into shared browser lifecycles; never reads stored or control credentials. */
export class OperatorApiSession implements RallarRoomEntry.Auth {
    private current: AuthSession | undefined;
    private readonly changes = new SynchronousNotifications<RallarAuthState>((error) =>
        console.error('Operator session listener failed', error)
    );

    constructor(session: AuthSession | null) {
        this.current = session ?? undefined;
    }

    session(): AuthSession | undefined {
        return this.current;
    }

    onChange(listener: RallarAuthChangeListener, options?: RallarOnChangeOptions): () => void {
        return options?.emitCurrent === false
            ? this.changes.subscribe(listener).unsubscribe
            : this.changes.subscribeAndNotify(listener, {
                authenticated: this.current !== undefined,
                reason: 'current',
                session: this.current
            }).unsubscribe;
    }

    setSession(session: AuthSession | null): void {
        this.current = session ?? undefined;
        this.changes.publishLatest({
            authenticated: session !== null,
            reason: session === null ? 'logout' : 'login',
            session: this.current
        });
    }
}
