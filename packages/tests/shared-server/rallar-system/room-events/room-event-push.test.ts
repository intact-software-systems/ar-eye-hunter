import { expect, it } from 'vitest';
import { createRoomEvent, changeRoomEvent } from '@shared/api/room-events/room-event.ts';
import { RoomEventRepository } from '@shared-server/rallar-system/room-events/room-event-repository.ts';

const lobby = { applicationId: 'club', workspaceId: 'park', groupId: 'pickup' };
const facts = { serviceId: 'rallar', traceId: 'test', createdAtEpochMs: 20, retentionMs: 60_000, audience: ['guest'] };
const repository = new RoomEventRepository({ findEntry: async () => undefined });
const event = createRoomEvent({ lobby, organizerId: 'admin', nowEpochMs: 1,
    command: { action: 'create', courts: [{groupId: 'east', capacity: 1}], closesAt: 3_600_000 } });
const consent = changeRoomEvent({ event, principalId: 'guest', nowEpochMs: 10, command: { action: 'enable-court-alerts',
    subscription: { endpoint: 'https://web.push.apple.com/test', p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } } });
const offered = changeRoomEvent({ event: consent, principalId: 'guest', nowEpochMs: 20,
    command: {action: 'propose', partyId: 'solo', players: ['guest']} });

it('commits one private delivery per new court offer and opted-in device', () => {
    const publish = (before: typeof event, after: typeof event) => repository.prepare({
        value: before, entry: { key: 'event', revision: 1, updatedTimestamp: new Date(facts.createdAtEpochMs).toISOString(), value: JSON.stringify(before), expireAtTimestamp: 3_600_000 }
    }, after, [], facts).outbox.map(row => row.entry).filter(entry => entry.key.topicId === 'room-event.court-alert');
    const alerts = publish(consent, offered);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts)).not.toContain('web.push.apple.com');
    expect(publish(offered, offered)).toEqual([]);
    const fresh = changeRoomEvent({ event: offered, principalId: 'admin', nowEpochMs: 21,
        command: {action: 'release', groupId: 'east', occurrence: 1, requeue: false} });
    expect(publish(offered, fresh)).toEqual([]);
});

it('rechecks consent, assignment, membership and deadline before each delivery attempt', async () => {
    const { deliverCourtAlert } = await import('@shared-server/rallar-system/room-events/deliver-court-alert.ts');
    const alert = { lobby, principalId: 'guest', consentRevision: 2, offerRevision: 3, dueAtEpochMs: 20 };
    let event = offered;
    let eligible = true;
    let now = 21;
    let attempts = 0;
    let retired = 0;
    const run = () => deliverCourtAlert(alert, {
        readEvent: async () => event, canReceive: async () => eligible, nowEpochMs: () => now,
        send: async () => { attempts++; if (attempts === 1) throw new Error('provider unavailable'); return 'gone'; },
        retireDevice: async () => { retired++; }
    });
    await expect(run()).rejects.toThrow('provider unavailable');
    await run();
    expect([attempts, retired]).toEqual([2, 1]);
    eligible = false;
    await run();
    eligible = true;
    now = 120_020;
    await run();
    now = 22;
    event = changeRoomEvent({ event, principalId: 'guest', nowEpochMs: now,
        command: { action: 'disable-court-alerts', endpoint: consent.alerts![0]!.subscription.endpoint } });
    await run();
    expect(attempts).toBe(2);
});

it('delivers encrypted Web Push to the allowed provider, collapses retries and handles retired subscriptions', async () => {
    const { generateVAPIDKeys } = await import('web-push');
    const { EventWebPush } = await import('@shared-server/rallar-system/room-events/event-web-push.ts');
    const deviceKeys = generateVAPIDKeys();
    const device = { endpoint: 'https://web.push.apple.com/device', p256dh: deviceKeys.publicKey, auth: 'A'.repeat(22) };
    const requests: RequestInit[] = [];
    let status = 201;
    const provider = new EventWebPush({ ...generateVAPIDKeys(), subject: 'mailto:operator@example.com' }, async (_url, request) => {
        requests.push(request!);
        return new Response(null, { status });
    }, () => 10);
    const alert = { lobby, principalId: 'guest', consentRevision: 2, offerRevision: 3, dueAtEpochMs: 10 };
    await expect(provider.send(device, alert, 3010)).resolves.toBe('accepted');
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('authorization')).toMatch(/^vapid /);
    expect(headers.get('ttl')).toBe('3');
    expect(requests[0]?.redirect).toBe('error');
    status = 503;
    await expect(provider.send(device, alert, 3010)).rejects.toThrow();
    expect(new Headers(requests[1]?.headers).get('topic')).toBe(headers.get('topic'));
    status = 410;
    await expect(provider.send(device, alert, 3010)).resolves.toBe('gone');
    await expect(provider.send({ ...device, endpoint: 'https://localhost/internal' }, alert, 3010)).rejects.toThrow();
    expect(requests).toHaveLength(3);
});
