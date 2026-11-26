import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { expect, it } from 'vitest';
import { changeRoomEvent, createRoomEvent, projectRoomEvent } from '@shared/api/room-events/room-event.ts';
import { decodeRoomEvent, decodeRoomEventCommand } from '@shared/api/room-events/decode-room-event.ts';

const lobby = { applicationId: 'pickup', workspaceId: 'park', groupId: 'lobby' };
const subscription = { endpoint: 'https://web.push.apple.com/device-token', p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) };
const initial = createRoomEvent({ lobby, organizerId: 'admin', nowEpochMs: 1,
    command: { action: 'create', courts: [{ groupId: 'east', capacity: 1 }], closesAt: 500_000 } });
const update = (event: typeof initial, principalId: string, command: ApiJsonValue) =>
    changeRoomEvent({ event, principalId, command: decodeRoomEventCommand(command), nowEpochMs: 10 });

it('binds court alerts to a player and device until opt-out, removal or event closure', () => {
    const enable = { action: 'enable-court-alerts', subscription };
    const consent = decodeRoomEvent(update(initial, 'alice', enable));
    expect(consent.alerts).toEqual([{ principalId: 'alice', subscription, revision: 2 }]);
    expect(JSON.stringify(projectRoomEvent(consent, 'alice'))).not.toContain(subscription.endpoint);
    expect(update(consent, 'alice', enable)).toEqual(consent);
    const disable = { action: 'disable-court-alerts', endpoint: subscription.endpoint };
    expect(update(consent, 'bob', disable)).toEqual(consent);
    expect(update(consent, 'alice', disable).alerts).toBeUndefined();
    expect(update(consent, 'admin', { action: 'remove', targetId: 'alice' }).alerts).toBeUndefined();
    expect(update(consent, 'admin', { action: 'close' }).alerts).toBeUndefined();
    expect(changeRoomEvent({ event: consent, command: { action: 'settle' }, principalId: 'admin', nowEpochMs: 500_000 }).alerts).toBeUndefined();
});

it('rejects noncanonical device authentication keys', () => {
    expect(() => decodeRoomEventCommand({ action: 'enable-court-alerts', subscription: {
        ...subscription, auth: 'A'.repeat(21) + 'B'
    } })).toThrow('Invalid Web Push keys');
});
