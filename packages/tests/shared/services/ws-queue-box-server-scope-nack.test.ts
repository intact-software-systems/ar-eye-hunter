import { describe, expect, it } from 'vitest';

import { decodeALNackPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import {
    createRoomMessage,
    createServerIngressFixture
} from './ws-queue-box-server-ingress-fixture.ts';

const OTHER_WORKSPACE = { applicationId: 'app', workspaceId: 'other' };

describe('WS ingress scope refusal', () => {
    it('answers a room message outside its connection scope with the authorizer NACK', async () => {
        const fixture = await createServerIngressFixture(undefined, 'session-1', () => ({
            scope: OTHER_WORKSPACE,
            expiresAtEpochMs: Date.now() + 60_000
        }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({ authorized: true })
        });

        const result = await fixture.service.acceptIncomingMessage(
            createRoomMessage(),
            'session-1'
        );

        expect(result.left).toEqual({
            code: 'unauthorized',
            message: 'AL message message-1 addresses app/workspace, outside its connection\'s authenticated scope'
        });
        const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
        expect(controls).toMatchObject([{
            id: { senderId: 'server' },
            targets: { mode: 'unicast', toPeerId: 'session-1' },
            payload: { typeId: 'al.control.nack.v1' }
        }]);
        expect(decodeALNackPayload(JSON.parse(controls[0]!.payload.resource))).toMatchObject({
            fromPeerId: 'server',
            toPeerId: 'session-1',
            msgId: 'message-1',
            reason: 'unauthorized'
        });
        expect(fixture.admission.data.size).toBe(0);
        expect(fixture.delivered).toEqual([]);
    });

    it('refuses a room in another scope before the room authorizer can read it', async () => {
        const fixture = await createServerIngressFixture(undefined, 'session-1', () => ({
            scope: OTHER_WORKSPACE,
            expiresAtEpochMs: Date.now() + 60_000
        }));
        const authorized: string[] = [];
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async (message) => {
                authorized.push(message.id.msgId);
                return {
                    authorized: false,
                    reason: 'unauthorized',
                    logMessage: 'not a member of the foreign room',
                    sendNack: true,
                    serverSnapshotVersion: 41
                };
            }
        });

        const result = await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1');

        expect(result.left?.message).toBe(
            'AL message message-1 addresses app/workspace, outside its connection\'s authenticated scope'
        );
        expect(authorized).toEqual([]);
        const controls = fixture.socket.sent.map((frame) => decodePersistedALMessage(String(frame)));
        expect(controls).toHaveLength(1);
        const nack = decodeALNackPayload(JSON.parse(controls[0]!.payload.resource));
        expect(nack).toMatchObject({ msgId: 'message-1', reason: 'unauthorized' });
        expect(nack).not.toHaveProperty('serverSnapshotVersion');
        expect(fixture.admission.data.size).toBe(0);
    });

    it('stays silent when the wrapped authorizer sends no NACKs', async () => {
        const fixture = await createServerIngressFixture(undefined, 'session-1', () => ({
            scope: OTHER_WORKSPACE,
            expiresAtEpochMs: Date.now() + 60_000
        }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: false,
            authorize: async () => ({ authorized: true })
        });

        expect(
            (await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).left
                ?.code
        ).toBe('unauthorized');
        expect(fixture.socket.sent).toEqual([]);
        expect(fixture.admission.data.size).toBe(0);
    });

    it('answers an expired connection scope with the NACK', async () => {
        const fixture = await createServerIngressFixture(undefined, 'session-1', () => ({
            scope: { applicationId: 'app', workspaceId: 'workspace' },
            expiresAtEpochMs: 0
        }));
        fixture.service.authorizeInboundMessagesWith({
            sendNacks: true,
            authorize: async () => ({ authorized: true })
        });

        expect(
            (await fixture.service.acceptIncomingMessage(createRoomMessage(), 'session-1')).left
                ?.message
        )
            .toBe('AL message message-1 arrived without a current authenticated WS scope');
        expect(fixture.socket.sent).toHaveLength(1);
        expect(fixture.admission.data.size).toBe(0);
    });
});
