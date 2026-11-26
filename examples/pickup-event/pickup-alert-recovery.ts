import type { GroupRef } from '@shared/api/group-types.ts';
import { COURT_ALERT_OPENED, clearCourtAlertClick, readCourtAlertClick } from '@shared-web/browser/rooms/events/court-alert-click.ts';
import { readCourtAlertLaunch } from '@shared-web/browser/rooms/events/court-alert-notification.ts';
import type { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';

interface PickupRecovery {
    readonly lobby: GroupRef;
    readonly event: RallarRoomEvent;
    readonly signal: AbortSignal;
    readonly reportError: (message: string) => void;
}

export function followPickupAlert({ lobby, event, signal, reportError }: PickupRecovery) {
    const scope = new URL('./', location.href).href;
    let opened = readCourtAlertLaunch(new URL(location.href));
    async function refresh(): Promise<void> {
        const stored = 'caches' in window ? await readCourtAlertClick(caches, scope, lobby) : null;
        opened = stored ?? readCourtAlertLaunch(new URL(location.href));
        if (opened && !signal.aborted) await event.refresh();
    }
    const recover = () => { void refresh().catch(() => reportError('Could not recover the court alert.')); };
    navigator.serviceWorker?.addEventListener('message', message => {
        if (message.data === COURT_ALERT_OPENED) recover();
    }, { signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) recover(); }, { signal });
    window.addEventListener('hashchange', recover, { signal });
    return {
        current: () => opened,
        refresh,
        async dismiss() {
            if (!opened || event.getState().error || event.getState().retryPending) return;
            if ('caches' in window) await clearCourtAlertClick(caches, scope, opened);
            const url = new URL(location.href);
            url.hash = '';
            history.replaceState(null, '', url);
            opened = null;
        }
    };
}
