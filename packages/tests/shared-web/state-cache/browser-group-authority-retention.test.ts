import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    initHeartbeat,
    stopHeartbeat
} from '@shared-web/browser/session/browser-session-heartbeat.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { initialiseBrowserCacheRepositories } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import {
    newALEventRoute,
    newALMulticastMessage
} from '@shared/al-contracts/al-contract.ts';
import type {
    AuthSession,
    ClientInfo,
    OverlayInfo
} from '@shared/api/api-config.ts';
import { isSameGroupRef, toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import { computeRtcRoomSnapshotAdmission } from '@shared/multicast/rtc-room-snapshot-admission.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import {
    findGroupStateSnapshotsBySessionIds,
    observeGroupStateSnapshot,
    onGroupStateSnapshotChange,
    readableGroupStateSnapshotCache,
    removeGroupStateSnapshotIfUnchanged,
    setGroupStateSnapshot,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';
import {
    readableAcceptedOverlayCache,
    setCurrentAcceptedServerOverlayById
} from '@shared/repository/overlays-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';

import {
    createActiveClientInstanceFixture,
    createActiveClientSessionFixture,
    createClientSnapshotFixture
} from '../authoritative-group-fixtures.ts';
import {
    createGroupSnapshot
} from './browser-state-cache-lifecycle-fixtures.ts';

const roomRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};
const overlayId = toScopedOverlayId(roomRef);
const clientData: ClientInfo = {
    clientId: 'receiver',
    sessionId: 'receiver',
    isOnline: true
};
const authSession: AuthSession = {
    clientId: clientData.clientId,
    sessionId: clientData.sessionId,
    username: clientData.clientId,
    accessToken: 'test-token',
    expiresAtEpochMs: 180_000
};

describe('browser group authority retention', () => {
    beforeEach(async () => {
        await defaultRepositoryManager.clear();
        configureApiClient({ apiBaseUrl: '' });
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        initialiseBrowserCacheRepositories();
    });

    afterEach(() => {
        stopHeartbeat();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps room authority readable after a successful current heartbeat renews its cache lifetime', async () => {
        const current = createRoomAuthority(180_000, 1_000);
        const overlay = createAcceptedOverlay();
        const message = createRoomMessage();
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        expect(setCurrentAcceptedServerOverlayById(overlayId, overlay)).toBe('initial-set');

        vi.setSystemTime(50_000);
        const fetchUrls = await runSuccessfulHeartbeat(current);

        vi.setSystemTime(70_001);
        const readableAuthority = readRtcRoomAuthority();
        const acceptedOverlay = readableAcceptedOverlayCache().read(overlayId);
        const admission = computeRtcRoomSnapshotAdmission({
            message,
            snapshot: readableAuthority,
            overlay: acceptedOverlay,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            nowMs: Date.now()
        });

        expect.soft(readableAuthority).toEqual(current);
        expect.soft(acceptedOverlay).toEqual(overlay);
        expect(admission.kind).toBe('authorized');
        expect(fetchUrls).toEqual([
            expect.stringContaining('/clients/receiver/instances/receiver/sessions/receiver/heartbeat/requests/'),
            expect.stringContaining('/groups/room-1/sessions/receiver/heartbeat/requests/')
        ]);
    });

    it('adopts whole renewed session leases from a successful current heartbeat', async () => {
        const previous = createRoomAuthority(40_000, 1_000);
        const renewed = createRoomAuthority(120_000, 20_000);
        const overlay = createAcceptedOverlay();
        const message = createRoomMessage();
        expect(observeGroupStateSnapshot(previous)).toBe('inserted');
        expect(setCurrentAcceptedServerOverlayById(overlayId, overlay)).toBe('initial-set');

        vi.setSystemTime(20_000);
        await runSuccessfulHeartbeat(renewed);

        vi.setSystemTime(50_000);
        const readableAuthority = readRtcRoomAuthority();
        const acceptedOverlay = readableAcceptedOverlayCache().read(overlayId);
        const admission = computeRtcRoomSnapshotAdmission({
            message,
            snapshot: readableAuthority,
            overlay: acceptedOverlay,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            nowMs: Date.now()
        });

        expect.soft(
            readableAuthority?.activeSessions.map((session) => ({
                sessionId: session.sessionId,
                lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
                expiresAtEpochMs: session.expiresAtEpochMs
            }))
        ).toEqual(
            renewed.activeSessions.map((session) => ({
                sessionId: session.sessionId,
                lastHeartbeatAtEpochMs: session.lastHeartbeatAtEpochMs,
                expiresAtEpochMs: session.expiresAtEpochMs
            }))
        );
        expect.soft(acceptedOverlay).toEqual(overlay);
        expect(admission.kind).toBe('authorized');
        expect(findGroupStateSnapshotsBySessionIds(['origin', 'receiver'])).toEqual([
            renewed
        ]);
    });

    it.each([
        {
            caseName: 'an older lease pair',
            candidate: (current: GroupSnapshot) =>
                withLeasePairs(current, [
                    [10_000, 110_000],
                    [10_000, 110_000]
                ])
        },
        {
            caseName: 'a crossed lease pair',
            candidate: (current: GroupSnapshot) =>
                withLeasePairs(current, [
                    [30_000, 110_000],
                    [30_000, 110_000]
                ])
        },
        {
            caseName: 'one ineligible session pair',
            candidate: (current: GroupSnapshot) =>
                withLeasePairs(current, [
                    [30_000, 130_000],
                    [10_000, 130_000]
                ])
        },
        {
            caseName: 'a reduced session inventory',
            candidate: (current: GroupSnapshot) =>
                withActiveSessions(
                    current,
                    current.activeSessions.slice(0, 1)
                )
        },
        {
            caseName: 'an expanded session inventory',
            candidate: (current: GroupSnapshot) =>
                withActiveSessions(current, [
                    ...current.activeSessions,
                    {
                        ...current.activeSessions[0]!,
                        sessionId: 'origin-other-session'
                    }
                ])
        }
    ])('does not revive expired authority from $caseName', ({ candidate }) => {
        const current = createRoomAuthority(120_000, 20_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        vi.setSystemTime(61_001);
        expect(readRtcRoomAuthority()).toBeUndefined();

        adoptGroupSnapshotsFromHeartbeat([current], [candidate(current)]);

        expect(readRtcRoomAuthority()).toBeUndefined();
    });

    it.each([
        {
            caseName: 'changed non-lease authority',
            candidate: (current: GroupSnapshot): GroupSnapshot => ({
                ...current,
                group: { ...current.group, displayName: 'Conflicting room name' }
            })
        },
        {
            caseName: 'a changed session generation',
            candidate: (current: GroupSnapshot): GroupSnapshot => ({
                ...current,
                activeSessions: current.activeSessions.map((session) => ({
                    ...session,
                    generationId: `${session.generationId}-other`
                }))
            })
        },
        {
            caseName: 'changed snapshot counts',
            candidate: (current: GroupSnapshot): GroupSnapshot => ({
                ...current,
                memberCount: current.memberCount + 1
            })
        },
        {
            caseName: 'a reordered session inventory',
            candidate: (current: GroupSnapshot): GroupSnapshot =>
                withActiveSessions(
                    current,
                    current.activeSessions.toReversed()
                )
        }
    ])('preserves the equal-causal conflict for $caseName after cache expiry', ({ candidate }) => {
        const current = createRoomAuthority(120_000, 20_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        vi.setSystemTime(61_001);
        expect(readRtcRoomAuthority()).toBeUndefined();

        expect(() => {
            adoptGroupSnapshotsFromHeartbeat([current], [candidate(current)]);
        }).toThrow(StateSnapshotRevisionConflictError);
        expect(readRtcRoomAuthority()).toBeUndefined();
    });

    it('makes a renewal win against cleanup captured before the heartbeat', () => {
        const current = createRoomAuthority(120_000, 20_000);
        const renewed = createRoomAuthority(140_000, 30_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');

        adoptGroupSnapshotsFromHeartbeat([current], [renewed]);

        expect(removeGroupStateSnapshotIfUnchanged(current.group, current)).toBe(false);
        expect(readRtcRoomAuthority()).toBe(renewed);
    });

    it('installs a new observation identity for an exact heartbeat payload duplicate', () => {
        const current = createRoomAuthority(120_000, 20_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');

        adoptGroupSnapshotsFromHeartbeat([current], [current]);

        const renewed = readRtcRoomAuthority();
        expect(renewed).toEqual(current);
        expect(renewed).not.toBe(current);
        expect(removeGroupStateSnapshotIfUnchanged(current.group, current)).toBe(false);
    });

    it('does not recreate authority when captured cleanup wins before renewal', () => {
        const current = createRoomAuthority(120_000, 20_000);
        const renewed = createRoomAuthority(140_000, 30_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        expect(removeGroupStateSnapshotIfUnchanged(current.group, current)).toBe(true);

        adoptGroupSnapshotsFromHeartbeat([current], [renewed]);

        expect(readRtcRoomAuthority()).toBeUndefined();
    });

    it('preserves a concurrently accepted newer authority snapshot', () => {
        const current = createRoomAuthority(120_000, 20_000);
        const renewed = createRoomAuthority(140_000, 30_000);
        const newer = withCausalRevision(
            createRoomAuthority(160_000, 40_000),
            2
        );
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        expect(setGroupStateSnapshot(newer)).toBe(true);

        adoptGroupSnapshotsFromHeartbeat([current], [renewed]);

        expect(readRtcRoomAuthority()).toBe(newer);
    });

    it('expires room authority without a renewed observation while retaining the accepted overlay', () => {
        const current = createRoomAuthority(180_000, 1_000);
        const overlay = createAcceptedOverlay();
        const message = createRoomMessage();
        expect(observeGroupStateSnapshot(current)).toBe('inserted');
        expect(setCurrentAcceptedServerOverlayById(overlayId, overlay)).toBe('initial-set');

        vi.setSystemTime(61_001);
        const readableAuthority = readRtcRoomAuthority();
        const acceptedOverlay = readableAcceptedOverlayCache().read(overlayId);
        const admission = computeRtcRoomSnapshotAdmission({
            message,
            snapshot: readableAuthority,
            overlay: acceptedOverlay,
            selfPeerId: 'receiver',
            fromPeerId: 'origin',
            recipientPeerId: undefined,
            nowMs: Date.now()
        });

        expect(readableAuthority).toBeUndefined();
        expect(acceptedOverlay).toEqual(overlay);
        expect(admission).toEqual({
            kind: 'pending',
            reason: 'Awaiting a room authority observation'
        });
    });

    it('does not renew room authority from a generic duplicate replay', () => {
        const current = createRoomAuthority(180_000, 1_000);
        expect(observeGroupStateSnapshot(current)).toBe('inserted');

        vi.setSystemTime(50_000);
        expect(observeGroupStateSnapshot(current)).toBe('duplicate');
        vi.setSystemTime(70_001);

        expect(readRtcRoomAuthority()).toBeUndefined();
    });

    it('keeps ordinary newer-causal heartbeat adoption on the canonical path', () => {
        const current = createRoomAuthority(120_000, 20_000);
        const advanced = withCausalRevision(
            createRoomAuthority(140_000, 30_000),
            2
        );
        expect(observeGroupStateSnapshot(current)).toBe('inserted');

        adoptGroupSnapshotsFromHeartbeat([current], [advanced]);

        expect(readRtcRoomAuthority()).toBe(advanced);
    });

    it('does not emit an extra change for exact or lease-only causal duplicates', async () => {
        const changes: string[] = [];
        const unsubscribe = onGroupStateSnapshotChange((change) => {
            changes.push(change.kind);
        });
        const current = createRoomAuthority(40_000, 1_000);
        const renewed = createRoomAuthority(120_000, 20_000);

        try {
            expect(observeGroupStateSnapshot(current)).toBe('inserted');
            expect(observeGroupStateSnapshot(current)).toBe('duplicate');
            expect(observeGroupStateSnapshot(renewed)).toBe('duplicate');
            await waitForGroupStateSnapshotChangesIdle();

            expect(changes).toEqual(['created']);
        }
        finally {
            unsubscribe();
        }
    });
});

function createRoomAuthority(
    sessionExpiresAtEpochMs: number,
    lastHeartbeatAtEpochMs: number
): GroupSnapshot {
    const snapshot = createGroupSnapshot({
        ...roomRef,
        sessionIds: ['origin', 'receiver'],
        snapshotVersion: 1
    });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            expiresAtEpochMs: 180_000
        },
        activeSessions: snapshot.activeSessions.map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs,
            expiresAtEpochMs: sessionExpiresAtEpochMs
        }))
    };
}

async function runSuccessfulHeartbeat(group: GroupSnapshot): Promise<string[]> {
    const fetchUrls: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
            const url = String(input);
            fetchUrls.push(url);
            if (url.includes('/clients/receiver/')) {
                return jsonResponse(createHeartbeatClientSnapshot());
            }
            if (url.includes('/groups/room-1/')) {
                return jsonResponse(group);
            }
            return new Response('Unexpected heartbeat request', { status: 500 });
        })
    );

    const heartbeat = await initHeartbeat(clientData, {
        authSession,
        scope: {
            applicationId: roomRef.applicationId,
            workspaceId: roomRef.workspaceId
        },
        policies: { command: { maxAttempts: 1 } }
    });
    await vi.waitFor(() => {
        expect(
            clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(
                clientData.clientId
            )
        ).toBeDefined();
    });
    heartbeat.stop();
    await waitForGroupStateSnapshotChangesIdle();
    return fetchUrls;
}

function createHeartbeatClientSnapshot(): ClientSnapshot {
    const snapshot = createClientSnapshotFixture({
        applicationId: roomRef.applicationId,
        workspaceId: roomRef.workspaceId,
        principalId: clientData.clientId
    });
    return {
        ...snapshot,
        principal: { ...snapshot.principal, snapshotVersion: 2 },
        instances: [createActiveClientInstanceFixture({
            applicationId: roomRef.applicationId,
            workspaceId: roomRef.workspaceId,
            principalId: clientData.clientId,
            clientInstanceId: clientData.clientId
        })],
        activeSessions: [createActiveClientSessionFixture({
            applicationId: roomRef.applicationId,
            workspaceId: roomRef.workspaceId,
            principalId: clientData.clientId,
            clientInstanceId: clientData.clientId,
            sessionId: clientData.sessionId
        })],
        isOnline: true,
        activeSessionCount: 1
    };
}

function jsonResponse(body: ClientSnapshot | GroupSnapshot): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function createAcceptedOverlay(): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 1
        },
        provenance: 'server',
        state: 'active',
        overlayId,
        groupRef: roomRef,
        topology: 'tree',
        name: roomRef.groupId,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: ['origin'],
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}

function withLeasePairs(
    snapshot: GroupSnapshot,
    pairs: readonly (readonly [number, number])[]
): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session, index) => ({
            ...session,
            lastHeartbeatAtEpochMs: pairs[index]?.[0] ?? session.lastHeartbeatAtEpochMs,
            expiresAtEpochMs: pairs[index]?.[1] ?? session.expiresAtEpochMs
        }))
    };
}

function withActiveSessions(
    snapshot: GroupSnapshot,
    activeSessions: GroupSnapshot['activeSessions']
): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions,
        onlineMemberCount: new Set(activeSessions.map((session) => session.principalId)).size
    };
}

function withCausalRevision(
    snapshot: GroupSnapshot,
    revision: number
): GroupSnapshot {
    return {
        ...snapshot,
        causalRevision: {
            groupRevision: revision,
            presenceRevision: revision
        },
        group: {
            ...snapshot.group,
            snapshotVersion: revision,
            presenceVersion: revision
        }
    };
}

function createRoomMessage() {
    return newALMulticastMessage(
        'origin',
        newALEventRoute('room.chat', roomRef.groupId, 'message-1'),
        roomRef,
        'chat.v1',
        {},
        { ttlMs: 240_000 }
    );
}

function readRtcRoomAuthority(): GroupSnapshot | undefined {
    return readableGroupStateSnapshotCache().readAllValues()
        .find((snapshot) => isSameGroupRef(snapshot.group, roomRef));
}
