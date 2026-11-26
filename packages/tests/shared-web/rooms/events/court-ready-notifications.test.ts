import { decodeBase64Url } from '@shared/encoding/base64url.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { enableCourtReadyNotifications, disableCourtReadyNotifications } from '@shared-web/browser/rooms/events/court-ready-notifications.ts';
import type { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';

afterEach(() => vi.unstubAllGlobals());

it('preserves a usable queue after permission refusal and revokes consent only for this event', async () => {
    let permission: NotificationPermission = 'denied';
    vi.stubGlobal('Notification', { requestPermission: async () => permission });
    const endpoint = 'https://web.push.apple.com/test';
    const existingKey = 'B' + 'A'.repeat(86);
    const options = { applicationServerKey: Uint8Array.from(decodeBase64Url(existingKey).right!).buffer, userVisibleOnly: true };
    const subscription = { endpoint, options, unsubscribe: vi.fn(), toJSON: () => ({ endpoint, keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }) };
    const commands: RallarRoomEvent.Action[] = [];
    const event = { act: async (command: RallarRoomEvent.Action) => { commands.push(command); },
        getState: () => ({ busy: false, retryPending: false, error: null,
            view: { principalId: 'guest', closed: false } as RoomEvent.View }) };
    const pushManager = { getSubscription: async () => subscription, subscribe: vi.fn(async () => subscription) };
    expect(await enableCourtReadyNotifications(event, pushManager, 'B' + 'A'.repeat(86))).toBe('denied');
    expect(commands).toEqual([]);
    permission = 'granted';
    const newKey = 'BB' + 'A'.repeat(85);
    await expect(enableCourtReadyNotifications(event, pushManager, newKey)).rejects.toThrow(/different application server key/i);
    expect(commands).toEqual([]);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    await enableCourtReadyNotifications(event, pushManager, 'B' + 'A'.repeat(86));
    await disableCourtReadyNotifications(event, pushManager);
    expect(commands).toEqual([{ action: 'enable-court-alerts', subscription: { endpoint, ...subscription.toJSON().keys } },
        { action: 'disable-court-alerts', endpoint }]);
});

it('opens only the app scope and reports an old alert when the current court has turned over', async () => {
    const { courtReadyNotification, courtAlertLaunchUrl, readCourtAlertLaunch, courtAlertStatus } =
        await import('@shared-web/browser/rooms/events/court-alert-notification.ts');
    const lobby = {applicationId:'club', workspaceId:'park', groupId:'secret-event'};
    const push = { type:'rallar-court-ready' as const, lobby, offerRevision:9, tag:'a'.repeat(32) };
    const notification = courtReadyNotification(push);
    expect(notification.title).toBe('Your court is ready');
    expect(notification.options.body).toBe('Open the event to see your assignment.');
    const target = courtAlertLaunchUrl('https://example.com/app/', notification.options.data);
    expect(target.origin + target.pathname).toBe('https://example.com/app/');
    const launch = readCourtAlertLaunch(target);
    const offer = { groupId: 'east', occurrence: 1, partyId:'solo', deadline:200, offerRevision:9 };
    expect(courtAlertStatus(launch, {lobby, offer}, 199)).toBe('current');
    expect(courtAlertStatus(launch, {lobby, offer}, 200)).toBe('expired');
    expect(courtAlertStatus(launch, {lobby, offer: {...offer, offerRevision:11}}, 150)).toBe('expired');
    const injected = { ...push, url: 'https://unrelated.example' };
    expect(() => courtAlertLaunchUrl('https://example.com/app/', injected)).toThrow();
});

it('keeps a newer click received during dismissal of an older click', async () => {
    const { openCourtAlertClick, readCourtAlertClick, clearCourtAlertClick } = await import('@shared-web/browser/rooms/events/court-alert-click.ts');
    const scope = 'https://example.com/courts/';
    const lobby = { applicationId: 'club', workspaceId: 'event', groupId: 'lobby' };
    const first = { type: 'rallar-court-ready' as const, lobby, offerRevision: 1, tag: 'a'.repeat(32) };
    const second = { ...first, offerRevision: 2, tag: 'b'.repeat(32) };
    const rows = new Map<string, Response>();
    let beforeDelete: (() => Promise<void>) | null = null;
    const keyText = (key: RequestInfo | URL) => key instanceof Request ? key.url : String(key);
    const cache: Pick<Cache, 'match' | 'put' | 'delete'> = {
        match: async key => rows.get(keyText(key))?.clone(),
        put: async (key, value) => { rows.set(keyText(key), value); },
        delete: async key => {
            const next = beforeDelete;
            beforeDelete = null;
            await next?.();
            return rows.delete(keyText(key));
        }
    };
    const storage = { open: async () => cache };
    const click = (message: typeof first) => openCourtAlertClick({ scope, storage, message, windows: async () => [], openWindow: async () => null });
    await click(first);
    beforeDelete = () => click(second);
    await clearCourtAlertClick(storage, scope, first);
    expect(await readCourtAlertClick(storage, scope, lobby)).toEqual(second);
});
