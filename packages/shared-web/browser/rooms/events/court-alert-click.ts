import type { GroupRef } from '@shared/api/group-types.ts';
import { decodeCourtAlertMessage, type CourtAlertMessage } from '@shared/api/room-events/court-alert-message.ts';
import { courtAlertLaunchUrl } from './court-alert-notification.ts';

interface ClickStorage {
    open(name: string): Promise<Pick<Cache, 'match' | 'put' | 'delete'>>;
}

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

function offerClickKey(event: URL, tag: string): URL {
    const offer = new URL(event);
    offer.searchParams.set('offer', tag);
    return offer;
}

/** Put the intent before activating the app. A Home Screen launch can disregard the navigation URL. */
export async function openCourtAlertClick(input: {
    readonly scope: string;
    readonly storage: ClickStorage;
    readonly message: CourtAlertMessage;
    readonly windows: () => Promise<readonly AlertWindow[]>;
    readonly openWindow: (url: string) => Promise<object | null>;
}): Promise<void> {
    const message = decodeCourtAlertMessage(input.message);
    const target = courtAlertLaunchUrl(input.scope, message);
    const cache = await input.storage.open('rallar.court-alert-clicks');
    const eventKey = eventClickKey(input.scope, message.lobby);
    const previous = await (await cache.match(eventKey))?.text();
    await cache.put(offerClickKey(eventKey, message.tag), Response.json(message));
    await cache.put(eventKey, new Response(message.tag));
    if (previous && previous !== message.tag) await cache.delete(offerClickKey(eventKey, previous));
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

export async function readCourtAlertClick(storage: ClickStorage, scope: string, lobby: GroupRef): Promise<CourtAlertMessage | null> {
    const cache = await storage.open('rallar.court-alert-clicks');
    const eventKey = eventClickKey(scope, lobby);
    const tag = await (await cache.match(eventKey))?.text();
    if (!tag) return null;
    const response = await cache.match(offerClickKey(eventKey, tag));
    return response ? decodeCourtAlertMessage(await response.json()) : null;
}

/** Dismiss only the original hint after the player takes an explicit action on the recovered private view. */
export async function clearCourtAlertClick(storage: ClickStorage, scope: string, message: CourtAlertMessage): Promise<void> {
    const cache = await storage.open('rallar.court-alert-clicks');
    await cache.delete(offerClickKey(eventClickKey(scope, message.lobby), message.tag));
}
