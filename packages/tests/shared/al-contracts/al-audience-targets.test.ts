import { describe, expect, it } from 'vitest';

import {
    isRoomScopedALMessage,
    newALBroadcastMessage,
    newALPrincipalBroadcastMessage,
    newALRoute,
    readALTargetGroupRef,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodeALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const PRINCIPAL = { applicationId: 'app', workspaceId: 'workspace', principalId: 'principal-1' };
const ROUTE = newALRoute('app.suggestion', 'room-1', 'resource-1');

describe('a principal broadcast in a room', () => {
    it('names the room and the principal, keeps the room send options, and decodes', () => {
        const message = newALPrincipalBroadcastMessage('a', ROUTE, { groupRef: ROOM, principalRef: PRINCIPAL }, 'app.suggestion.v1', {}, {
            exceptPeerIds: ['b'],
            minSnapshotVersion: 7,
            rosterVersion: 4,
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: 30_000
        });

        expect(message.targets).toEqual({
            mode: 'broadcast',
            scope: 'principal',
            groupRef: ROOM,
            principalRef: PRINCIPAL,
            exceptPeerIds: ['b'],
            minSnapshotVersion: 7,
            rosterVersion: 4
        });
        expect(message.delivery).toEqual({ ownership: undefined, reliability: 'at-least-once', ack: 'receiver' });
        expect(decodeALMessage(JSON.stringify(message)).left).toBeUndefined();
    });

    it('is room-scoped by its room, and a principal broadcast that names no room is not', () => {
        const inRoom = newALPrincipalBroadcastMessage('a', ROUTE, { groupRef: ROOM, principalRef: PRINCIPAL }, 'app.suggestion.v1', {});
        const roomless: ALMessage = { ...inRoom, targets: { mode: 'broadcast', scope: 'principal', principalRef: PRINCIPAL } };

        expect(isRoomScopedALMessage(inRoom)).toBe(true);
        expect(readALTargetGroupRef(inRoom)).toEqual(ROOM);
        expect(isRoomScopedALMessage(roomless)).toBe(false);
        expect(readALTargetGroupRef(roomless)).toBeUndefined();
    });
});

describe('a room broadcast with a fixed audience', () => {
    it('carries the sender\'s list beside the room and decodes', () => {
        const message = newALBroadcastMessage('a', ROUTE, 'room', 'app.suggestion.v1', {}, {
            groupRef: ROOM,
            recipientPeerIds: ['b', 'c']
        });

        expect(message.targets).toMatchObject({ mode: 'broadcast', scope: 'room', groupRef: ROOM, recipientPeerIds: ['b', 'c'] });
        expect(decodeALMessage(JSON.stringify(message)).left).toBeUndefined();
    });

    it('keeps a list given with another scope, which the canonical decoder refuses as malformed', () => {
        const message = newALBroadcastMessage('a', ROUTE, 'world', 'app.suggestion.v1', {}, { recipientPeerIds: ['b'] });

        expect(message.targets).toMatchObject({ mode: 'broadcast', scope: 'world', recipientPeerIds: ['b'] });
        expect(decodeALMessage(JSON.stringify(message)).left).toEqual({
            code: 'malformed',
            message: 'Persisted AL fixed recipient audience requires room scope'
        });
    });
});

describe('the receiver planner of a listed room broadcast', () => {
    it('delivers to a listed session and forwards only to listed children', () => {
        const message = newALBroadcastMessage('a', ROUTE, 'room', 'app.suggestion.v1', {}, {
            groupRef: ROOM,
            recipientPeerIds: ['self', 'c']
        });

        const plan = planALMessageHandling(message, {
            nowMs: message.id.ts,
            selfPeerId: 'self',
            fromPeerId: 'a',
            groupMemberPeerIds: ['a', 'self', 'b', 'c'],
            connectedPeerIds: ['a', 'b', 'c'],
            overlayNeighborPeerIds: ['b', 'c']
        });

        expect(plan.localDelivery.enabled).toBe(true);
        expect(plan.forwarding.nextHopPeerIds).toEqual(['c']);
    });

    it('delivers nothing to a session the list leaves out', () => {
        const message = newALBroadcastMessage('a', ROUTE, 'room', 'app.suggestion.v1', {}, {
            groupRef: ROOM,
            recipientPeerIds: ['c']
        });

        const plan = planALMessageHandling(message, { nowMs: message.id.ts, selfPeerId: 'self', fromPeerId: 'a' });

        expect(plan.localDelivery.enabled).toBe(false);
    });
});
