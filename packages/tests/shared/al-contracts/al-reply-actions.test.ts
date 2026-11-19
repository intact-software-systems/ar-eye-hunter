import { describe, expect, it } from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    newALUntargetedMessage,
    readALTargetGroupRef,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { newALReplyMessage } from '@shared/al-contracts/reply/new-al-reply-message.ts';
import { toALCorrId, toALReplyActions } from '@shared/al-contracts/reply/to-al-reply-actions.ts';
import { toALReplyContextId } from '@shared/al-contracts/reply/to-al-reply-context-id.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { validateALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const ROUTE = newALRoute('app.command', 'room-1', 'resource-1');
const ACTIONS = { corrId: 'corr-1', replyToMsgId: 'request-1' };
const PRINCIPAL = {
    groupRef: ROOM,
    principalRef: { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId, principalId: 'user-1' }
} as const;

function newRequest(senderId: string, groupRef?: typeof ROOM, actions?: ALMessage['actions']): ALMessage {
    return newALUnicastMessage({
        createdAtEpochMs: Date.now(),
        senderId,
        route: ROUTE,
        toPeerId: 'server',
        typeId: 'app.ask.v1',
        resource: { q: 1 },
        options: { groupRef, actions }
    });
}

describe('the correlation id of a message', () => {
    it('is its own msgId when the sender passed none', () => {
        const request = newRequest('client');

        expect(toALCorrId(request)).toBe(request.id.msgId);
    });

    it('is the actions.corrId a re-ask carries', () => {
        const reAsk = newRequest('client', undefined, { corrId: 'first-ask' });

        expect(toALCorrId(reAsk)).toBe('first-ask');
    });
});

describe('the reply actions of a request', () => {
    it('start a correlation on the request itself', () => {
        const request = newRequest('client');

        expect(toALReplyActions(request)).toEqual({ corrId: request.id.msgId, replyToMsgId: request.id.msgId });
    });

    it('keep the correlation of a re-ask and answer the re-ask, not the first ask', () => {
        const reAsk = newRequest('client', undefined, { corrId: 'first-ask' });

        expect(toALReplyActions(reAsk)).toEqual({ corrId: 'first-ask', replyToMsgId: reAsk.id.msgId });
    });
});

describe('the context a reply routes in', () => {
    const customContext = newALRoute('app.command', 'custom', 'resource-1');

    it('is the room id when the request names a room, whatever context it used', () => {
        const roomBroadcast = newALBroadcastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'client',
            route: customContext,
            scope: 'room',
            typeId: 't',
            resource: {},
            options: { groupRef: ROOM }
        });

        expect(toALReplyContextId(roomBroadcast)).toBe(ROOM.groupId);
        expect(toALReplyContextId(newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'client',
            route: customContext,
            toPeerId: 'server',
            typeId: 't',
            resource: {},
            options: { groupRef: ROOM }
        })))
            .toBe(ROOM.groupId);
    });

    it('is the request context when the request names no room', () => {
        expect(toALReplyContextId(newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'client',
            route: customContext,
            toPeerId: 'server',
            typeId: 't',
            resource: {}
        }))).toBe('custom');
    });
});

describe('the actions option of the message builders', () => {
    const builders: ReadonlyArray<readonly [string, (actions?: ALMessage['actions']) => ALMessage]> = [
        ['untargeted', (actions) =>
            newALUntargetedMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                typeId: 't',
                resource: {},
                options: { actions }
            })],
        ['unicast', (actions) =>
            newALUnicastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                toPeerId: 'b',
                typeId: 't',
                resource: {},
                options: { actions }
            })],
        ['multicast', (actions) =>
            newALMulticastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                groupRef: ROOM,
                typeId: 't',
                resource: {},
                options: { actions }
            })],
        ['room broadcast', (actions) =>
            newALBroadcastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                scope: 'room',
                typeId: 't',
                resource: {},
                options: { groupRef: ROOM, actions }
            })],
        ['principal broadcast', (actions) =>
            newALPrincipalBroadcastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                target: PRINCIPAL,
                typeId: 't',
                resource: {},
                options: { actions }
            })]
    ];

    it.each(builders)('writes them verbatim on a %s message', (_name, build) => {
        expect(build(ACTIONS).actions).toEqual(ACTIONS);
    });

    it.each(builders)('leaves the envelope of a %s message without an actions section when none is given', (_name, build) => {
        const message = build();

        expect(message.actions).toBeUndefined();
        expect('actions' in message).toBe(false);
    });
});

describe('the trace of the message builders', () => {
    const builders: ReadonlyArray<readonly [string, (traceId?: string) => ALMessage]> = [
        ['untargeted', (traceId) =>
            newALUntargetedMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                typeId: 't',
                resource: {},
                options: { traceId }
            })],
        ['unicast', (traceId) =>
            newALUnicastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                toPeerId: 'b',
                typeId: 't',
                resource: {},
                options: { traceId }
            })],
        ['multicast', (traceId) =>
            newALMulticastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                groupRef: ROOM,
                typeId: 't',
                resource: {},
                options: { traceId }
            })],
        ['room broadcast', (traceId) =>
            newALBroadcastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                scope: 'room',
                typeId: 't',
                resource: {},
                options: { groupRef: ROOM, traceId }
            })],
        ['principal broadcast', (traceId) =>
            newALPrincipalBroadcastMessage({
                createdAtEpochMs: Date.now(),
                senderId: 'a',
                route: ROUTE,
                target: PRINCIPAL,
                typeId: 't',
                resource: {},
                options: { traceId }
            })]
    ];

    it.each(builders)('mints a valid trace on a %s message when the caller passes none', (_name, build) => {
        const first = build();

        expect(validateALTraceId(first.id.traceId)).toEqual([]);
        expect(build().id.traceId).not.toBe(first.id.traceId);
    });

    it.each(builders)('keeps the trace the caller passes on a %s message', (_name, build) => {
        expect(build('trace_01').id.traceId).toBe('trace_01');
    });
});

describe('the server reply to a request', () => {
    it('is an at-least-once unicast to the requester on the request topic, context and room', () => {
        const request = newRequest('client-session', ROOM);
        const reply = newALReplyMessage(request, { senderId: 'server', typeId: 'app.answer.v1', payload: { a: 2 } });

        expect(reply.targets).toEqual({ mode: 'unicast', toPeerId: 'client-session', groupRef: ROOM });
        expect(reply.route.topicId).toBe(request.route.topicId);
        expect(reply.route.contextId).toBe(request.route.contextId);
        expect(reply.route.resourceId).not.toBe(request.route.resourceId);
        expect(reply.id.senderId).toBe('server');
        expect(reply.payload.typeId).toBe('app.answer.v1');
        expect(JSON.parse(reply.payload.resource)).toEqual({ a: 2 });
        expect(readALTargetGroupRef(reply)).toEqual(ROOM);
        expect(reply.delivery).toEqual({
            ownership: undefined,
            reliability: AL_CHANNEL_SEND_DEFAULTS.command.reliability,
            ack: AL_CHANNEL_SEND_DEFAULTS.command.ack
        });
        expect(reply.delivery).toMatchObject({ reliability: 'at-least-once', ack: 'receiver' });
        expect(reply.constraints?.expiresAtMs).toBe(reply.id.ts + 30_000);
        expect(reply.actions).toEqual({ corrId: request.id.msgId, replyToMsgId: request.id.msgId });
    });

    it('carries the trace of the request', () => {
        const request = newALUnicastMessage({
            createdAtEpochMs: Date.now(),
            senderId: 'client-session',
            route: ROUTE,
            toPeerId: 'server',
            typeId: 'app.ask.v1',
            resource: {},
            options: { traceId: 'trace_01' }
        });

        expect(newALReplyMessage(request, { senderId: 'server', typeId: 't', payload: {} }).id.traceId).toBe('trace_01');
    });

    it('carries the correlation of a re-ask and answers the re-ask', () => {
        const reAsk = newRequest('client-session', ROOM, { corrId: 'first-ask' });
        const reply = newALReplyMessage(reAsk, { senderId: 'server', typeId: 't', payload: {} });

        expect(reply.actions).toEqual({ corrId: 'first-ask', replyToMsgId: reAsk.id.msgId });
    });

    it('routes a reply to a room broadcast with a custom context in the room id, as the server ingress requires', () => {
        const request = newALBroadcastMessage(
            {
                createdAtEpochMs: Date.now(),
                senderId: 'client-session',
                route: newALRoute('app.command', 'custom', 'resource-1'),
                scope: 'room',
                typeId: 'app.ask.v1',
                resource: { q: 1 },
                options: { groupRef: ROOM }
            }
        );
        const reply = newALReplyMessage(request, { senderId: 'server', typeId: 't', payload: {} });

        expect(reply.route.contextId).toBe(ROOM.groupId);
        expect(reply.targets).toEqual({ mode: 'unicast', toPeerId: 'client-session', groupRef: ROOM });
    });

    it('names no room when the request named none', () => {
        const reply = newALReplyMessage(newRequest('client-session'), { senderId: 'server', typeId: 't', payload: {} });

        expect(reply.targets).toEqual({ mode: 'unicast', toPeerId: 'client-session' });
        expect(readALTargetGroupRef(reply)).toBeUndefined();
    });

    it('mints a fresh resource id for every reply', () => {
        const request = newRequest('client-session');
        const input = { senderId: 'server', typeId: 't', payload: {} };

        expect(newALReplyMessage(request, input).route.resourceId)
            .not.toBe(newALReplyMessage(request, input).route.resourceId);
    });

    it('decodes through the canonical decoder with its actions intact', () => {
        const request = newRequest('client-session', ROOM);
        const reply = newALReplyMessage(request, { senderId: 'server', typeId: 't', payload: {} });
        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(reply)));

        expect(decoded.right?.actions).toEqual({ corrId: request.id.msgId, replyToMsgId: request.id.msgId });
    });

    it('decodes a re-ask that carries only a correlation id', () => {
        const reAsk = newRequest('client-session', ROOM, { corrId: 'first-ask' });
        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(reAsk)));

        expect(decoded.right?.actions).toEqual({ corrId: 'first-ask' });
        expect(decoded.right === undefined ? undefined : toALCorrId(decoded.right)).toBe('first-ask');
    });

    it('decodes a message without an actions section', () => {
        const decoded = decodeALMessageValue(JSON.parse(JSON.stringify(newRequest('client-session', ROOM))));

        expect(decoded.right).toBeDefined();
        expect(decoded.right?.actions).toBeUndefined();
    });
});
