import { describe, expect, it, vi } from 'vitest';

import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const COMMAND_CHANNEL = { purpose: 'command', durability: undefined, onStorageUnavailable: 'refuse' } as const;

describe('a WS send addressed to one peer (Q11)', () => {
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

    it('refuses a peer target on ws-then-rtc, which hands over at admission only (V1)', async () => {
        const fixture = createBrowserMessageSenderFixture();

        const sending = fixture.sender.sendTyped({
            typeId: 'relic.command.v1',
            payload: {},
            roomId: 'room',
            peerId: 'server',
            strategy: 'ws-then-rtc'
        }, COMMAND_CHANNEL);

        await expect(sending).rejects.toSatisfy(isRallarValidationError);
        // The default topic would fail the WS topic rule too; the peer refusal must come first.
        await expect(sending).rejects.toMatchObject({
            issues: [{
                path: '$.peerId',
                code: 'unsupported',
                message: 'A peer-addressed typed send takes the ws, rtc or rtc-with-ws-fallback strategy.'
            }]
        });
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

    it('refuses a peer target while the server names no peer id, which an older server would refuse (R-S3c-i-32)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        Object.assign(fixture.middleware.middleware.webSocketQueueBox, { serverPeerId: undefined });

        await expect(fixture.sender.sendTyped({
            typeId: 'relic.command.v1',
            topicId: 'room.relic.command',
            payload: { kind: 'start-expedition' },
            roomId: 'room',
            peerId: 'server',
            strategy: 'ws'
        }, COMMAND_CHANNEL)).rejects.toMatchObject({
            issues: [{
                path: '$.peerId',
                code: 'unsupported',
                message: 'A peer-addressed send needs a server that names its peer id; this server names none.'
            }]
        });
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

    it('admits a scope-all peer send under its own context id, which names no room to mismatch (C8)', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const envelope = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        const handle = await fixture.sender.sendWs({
            scope: 'all',
            peerId: 'callee',
            topicId: 'app.rallar.calls',
            typeId: 'app.rallar.calls.invite.v1',
            contextId: 'call-1',
            payload: { kind: 'invite' },
            reliability: 'best-effort'
        }, undefined);
        const outcome = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        expect(outcome.lifecycle.state).toBe('queued');
        expect(outcome.lifecycle.evidence.failure).toBeUndefined();
        expect(envelope.mock.calls[0][0]).toMatchObject({
            targets: { mode: 'unicast', toPeerId: 'callee' },
            route: { topicId: 'app.rallar.calls', contextId: 'call-1' }
        });
    });
});
