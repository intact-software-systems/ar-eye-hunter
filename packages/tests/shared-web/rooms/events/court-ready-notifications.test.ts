import { afterEach, expect, it, vi } from 'vitest';
import { enableCourtReadyNotifications, disableCourtReadyNotifications } from '@shared-web/browser/rooms/events/court-ready-notifications.ts';
import type { RallarRoomEvent } from '@shared-web/browser/rooms/events/rallar-room-event.ts';
import type { RoomEvent } from '@shared/api/room-events/room-event.ts';

afterEach(() => vi.unstubAllGlobals());

it('preserves a usable queue after permission refusal and revokes consent only for this event', async () => {
    let permission: NotificationPermission = 'denied';
    vi.stubGlobal('Notification', { requestPermission: async () => permission });
    const endpoint = 'https://web.push.apple.com/test';
    const subscription = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }) };
    const commands: RallarRoomEvent.Action[] = [];
    const event = { act: async (command: RallarRoomEvent.Action) => { commands.push(command); },
        getState: () => ({ busy: false, retryPending: false, error: null,
            view: { principalId: 'guest', closed: false } as RoomEvent.View }) };
    const pushManager = { getSubscription: async () => subscription, subscribe: async () => subscription };
    expect(await enableCourtReadyNotifications(event, pushManager, 'B' + 'A'.repeat(86))).toBe('denied');
    expect(commands).toEqual([]);
    permission = 'granted';
    await enableCourtReadyNotifications(event, pushManager, 'B' + 'A'.repeat(86));
    await disableCourtReadyNotifications(event, pushManager);
    expect(commands).toEqual([{ action: 'enable-court-alerts', subscription: { endpoint, ...subscription.toJSON().keys } },
        { action: 'disable-court-alerts', endpoint }]);
});

it('opens only the app scope and reports an old alert when the current court has turned over', async () => {
    const { courtReadyNotification, courtAlertLaunchUrl, readCourtAlertLaunch, courtAlertStatus } =
        await import('@shared-web/browser/rooms/events/court-alert-notification.ts');
    const lobby = {applicationId:'club', workspaceId:'park', groupId:'secret-event'};
    const push = { type:'rallar-court-ready', lobby, offerRevision:9, tag:'a'.repeat(32) };
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
    expect(() => courtAlertLaunchUrl('https://example.com/app/', { ...push, url:'https://unrelated.example' })).toThrow();
});
