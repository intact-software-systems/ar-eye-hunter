import { describe, expect, it } from 'vitest';

import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { computeRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const message = newALMulticastMessage('origin', { topicId: 'room.chat', contextId: 'room', resourceId: 'message' }, roomRef, 'chat.v1', {});
const nowMs = 100;

function snapshot(): GroupSnapshot {
    return createGroupSnapshotFixture({ ...roomRef, sessionIds: ['origin', 'relay', 'receiver', 'downstream'] });
}

function overlay(): OverlayInfo {
    return {
        overlayId: 'room',
        groupRef: roomRef,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'Room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        nextHopSessionIds: ['relay', 'downstream'],
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

describe('RTC room authority', () => {
    it('requires evidence for no-floor messages, then permits an active direct room recipient without topology', () => {
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, nowMs, overlay: undefined };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: snapshot() }).kind).toBe('authorized');
    });

    it('authorizes a different immediate relay only from a matching active server topology', () => {
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'relay', recipientPeerId: undefined, nowMs, snapshot: snapshot() };
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: overlay() }).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: undefined }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), provenance: 'bootstrap' } }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), nextHopSessionIds: ['downstream'] } }).kind).toBe('unauthorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, overlay: { ...overlay(), state: 'removed' } }).kind).toBe('unauthorized');
    });

    it('checks room scope and expiry before snapshot catch-up', () => {
        const current = snapshot();
        const versioned = { ...message, targets: { mode: 'multicast' as const, groupRef: roomRef, minSnapshotVersion: current.group.snapshotVersion + 1 } };
        const input = { message: versioned, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, overlay: undefined, nowMs };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: current }).kind).toBe('pending');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, group: { ...current.group, workspaceId: 'other' } } }).kind).toBe(
            'unauthorized'
        );
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, group: { ...current.group, expiresAtEpochMs: nowMs } } }).kind).toBe(
            'unauthorized'
        );
    });

    it('rejects an expired session or inactive member even while a stale session row remains', () => {
        const current = snapshot();
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'origin', recipientPeerId: undefined, overlay: undefined, nowMs };
        const expired = {
            ...current,
            activeSessions: current.activeSessions.map((session) => session.sessionId === 'origin' ? { ...session, expiresAtEpochMs: nowMs } : session)
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: expired }).kind).toBe('unauthorized');
        const originPrincipal = current.activeSessions.find((session) => session.sessionId === 'origin')!.principalId;
        const left = {
            ...current,
            members: current.members.map((member) =>
                member.principalId === originPrincipal && member.status === 'active' ? { ...member, status: 'left' as const, left: member.updated } : member
            )
        };
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: left }).kind).toBe('unauthorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, snapshot: { ...current, members: [], activeSessions: [] } }).kind).toBe('pending');
    });

    it('plans a frozen authority observation without changing it', () => {
        const current = snapshot();
        const input = { message, selfPeerId: 'receiver', fromPeerId: 'relay', recipientPeerId: undefined, overlay: overlay(), nowMs, snapshot: current };
        freezeRoomObservation(input);
        const before = JSON.stringify(input);
        const admitted = computeRtcRoomSnapshotAdmission(input);
        expect(admitted.kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission(input)).toEqual(admitted);
        expect(JSON.stringify(input)).toBe(before);
    });

    it('requires recipient membership and a permitted outgoing edge independent of diagnostics', () => {
        const input = {
            message,
            selfPeerId: 'receiver',
            fromPeerId: undefined,
            recipientPeerId: 'downstream',
            nowMs,
            snapshot: snapshot(),
            overlay: overlay()
        };
        expect(computeRtcRoomSnapshotAdmission(input).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, recipientPeerId: 'relay' }).kind).toBe('authorized');
        expect(computeRtcRoomSnapshotAdmission({ ...input, recipientPeerId: 'origin' }).kind).toBe('unauthorized');
        for (const visitedPeerIds of [[], ['receiver'], ['origin', 'relay', 'receiver']]) {
            expect(
                computeRtcRoomSnapshotAdmission({
                    ...input,
                    message: { ...message, diagnostics: { visitedPeerIds } },
                    overlay: { ...overlay(), state: 'removed' }
                }).kind
            ).toBe('unauthorized');
        }
    });
});

function freezeRoomObservation(value: object): void {
    Object.freeze(value);
    for (const child of Object.values(value)) {
        if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
            freezeRoomObservation(child);
        }
    }
}
