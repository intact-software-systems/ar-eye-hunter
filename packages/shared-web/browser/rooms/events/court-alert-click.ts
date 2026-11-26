import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeCourtAlertMessage, type CourtAlertMessage } from '@shared/api/room-events/court-alert-message.ts';
import { courtAlertLaunchUrl } from './court-alert-notification.ts';

interface AlertWindow {
    readonly url: string;
    focus(): Promise<object>;
    postMessage(message: string): void;
}

export const COURT_ALERT_OPENED = 'rallar:court-alert-opened';

function eventClickKey(scope: string, lobby: GroupRef): URL {
    const key = new URL('.rallar-court-click', scope);
    key.search = new URLSearchParams([['app', lobby.applicationId], ['workspace', lobby.workspaceId], ['room', lobby.groupId]]).toString();
    return key;
}

/** Put the intent before activating the app. A Home Screen launch can disregard the navigation URL. */
export async function openCourtAlertClick(input: {
    readonly scope: string;
    readonly storage: CacheStorage;
    readonly message: CourtAlertMessage;
    readonly windows: () => Promise<readonly AlertWindow[]>;
    readonly openWindow: (url: string) => Promise<object | null>;
}): Promise<void> {
    const message = decodeCourtAlertMessage(input.message);
    const target = courtAlertLaunchUrl(input.scope, message);
    const cache = await input.storage.open('rallar.court-alert-clicks');
    await cache.put(eventClickKey(input.scope, message.lobby), Response.json(message));
    const existing = (await input.windows()).find(client => {
        const url = new URL(client.url);
        return url.origin === target.origin && url.pathname === target.pathname;
    });
    if (existing) {
        existing.postMessage(COURT_ALERT_OPENED);
        try { await existing.focus(); return; }
        catch { /* The app may have closed after clients.matchAll. */ }
    }
    await input.openWindow(target.href);
}

export async function readCourtAlertClick(storage: CacheStorage, scope: string, lobby: GroupRef): Promise<CourtAlertMessage | null> {
    const cache = await storage.open('rallar.court-alert-clicks');
    const response = await cache.match(eventClickKey(scope, lobby));
    return response ? decodeCourtAlertMessage(await response.json()) : null;
}

/** Dismiss only the original hint after the player takes an explicit action on the recovered private view. */
export async function clearCourtAlertClick(storage: CacheStorage, scope: string, message: CourtAlertMessage): Promise<void> {
    const current = await readCourtAlertClick(storage, scope, message.lobby);
    if (current?.tag !== message.tag) return;
    const cache = await storage.open('rallar.court-alert-clicks');
    await cache.delete(eventClickKey(scope, message.lobby));
}
