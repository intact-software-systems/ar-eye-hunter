import { describe, expect, it, vi } from 'vitest';

import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const COMMAND_CHANNEL = { purpose: 'command', durability: undefined } as const;

describe('a WS send addressed to one peer (Q11, WS only)', () => {
    it('builds a receipted room unicast to the peer for a command channel', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs({
            typeId: 'relic.command.v1',
            topicId: 'room.relic.command',
            payload: { kind: 'start-expedition' },
            roomId: 'room',
            peerId: 'server'
        }, COMMAND_CHANNEL);

        const message = envelope.mock.calls[0][0];
        expect(message.targets).toEqual({
            mode: 'unicast',
            toPeerId: 'server',
            groupRef: ROOM_REF
        });
        expect(message.route).toMatchObject({ topicId: 'room.relic.command', contextId: 'room' });
        expect(message.delivery).toEqual({
            ownership: 'shared',
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
    });

    it('keeps a lane send to a peer on the lane defaults: at-least-once and no receipt', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs({
            typeId: 'app.note.v1',
            payload: { text: 'hi' },
            roomId: 'room',
            peerId: 'peer-b'
        }, undefined);

        expect(envelope.mock.calls[0][0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'peer-b', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'none' }
        });
    });

    it('refuses a peer target on any strategy but ws until the RTC unicast lands (S3c-ii)', async () => {
        const fixture = createBrowserMessageSenderFixture();

        const sending = fixture.sender.sendTyped({
            typeId: 'relic.command.v1',
            payload: {},
            roomId: 'room',
            peerId: 'server'
        }, COMMAND_CHANNEL);

        await expect(sending).rejects.toSatisfy(isRallarValidationError);
        // The default topic would fail the WS topic rule too; the peer refusal must come first.
        await expect(sending).rejects.toMatchObject({ issues: [{ path: '$.peerId', code: 'unsupported' }] });
    });

    it.each([
        ['exclusions', { exceptPeerIds: ['peer-c'] }],
        ['ordering', { orderingKey: 'k', seq: 1 }],
        ['a snapshot floor', { minSnapshotVersion: 3 }],
        ['a hop limit', { ttlHops: 2 }]
    ])(
        'refuses a peer target that carries %s, which a unicast cannot honour',
        async (_name, extra) => {
            const fixture = createBrowserMessageSenderFixture();

            const sending = fixture.sender.sendWs({
                typeId: 'app.note.v1',
                payload: {},
                roomId: 'room',
                peerId: 'peer-b',
                ...extra
            }, undefined);

            await expect(sending).rejects.toSatisfy(isRallarValidationError);
            await expect(sending).rejects.toMatchObject({
                issues: expect.arrayContaining([expect.objectContaining({ path: '$.peerId', code: 'unsupported' })])
            });
        }
    );

    it.each([
        ['an empty peer id', '', 'missing-peer-id'],
        ['a peer id the route-id rule refuses', ' peer-b ', 'not-trimmed']
    ])('refuses %s before it reaches the wire', async (_name, peerId, code) => {
        const fixture = createBrowserMessageSenderFixture();

        await expect(fixture.sender.sendWs({
            typeId: 'app.note.v1',
            payload: {},
            roomId: 'room',
            peerId
        }, undefined)).rejects.toMatchObject({ issues: [{ path: '$.peerId', code }] });
    });

    it('sends a typed ws-strategy send to its peer as the same room unicast', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendTyped({
            typeId: 'relic.command.v1',
            topicId: 'room.relic.command',
            payload: { kind: 'start-expedition' },
            roomId: 'room',
            peerId: 'server',
            strategy: 'ws'
        }, COMMAND_CHANNEL);

        expect(envelope.mock.calls[0][0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'server', groupRef: ROOM_REF },
            delivery: { reliability: 'at-least-once', ack: 'receiver' }
        });
    });
});
