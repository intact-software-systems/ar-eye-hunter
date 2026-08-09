import { describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import {
    type RallarOverlayTopologySnapshot,
    toOverlayInfoForSession,
} from '@shared/api/overlay-topology.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import {
    createAndSetBootstrapOverlays,
} from '@shared/repository/overlay-bootstrap.ts';
import {
    configureOverlayRepository,
    createAndSetStarOverlays,
    findOverlayById,
    readableOverlayCache,
    readOverlayAdoptionDiagnostics,
    resetOverlayAdoptionDiagnostics,
    setOverlayById,
} from '@shared/repository/overlays-repository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

const MAX_PEER_CONNECTIONS = 10;
const BOOTSTRAP_DEGREE = 5;

// The Phase 1 tier evidence for "overlay adoption ≈ 100% and outbound dials
// bounded": N real browser-side stacks (overlay repository semantics +
// WebRtcGroupManager over a fake connection service) burst-join one group,
// bootstrap with the bounded rendezvous star, then receive a server overlay
// planned against an OLDER group revision than the bootstrap star carries —
// the exact S5 condition under which the pre-Phase-1 tuple admission dropped
// every server overlay. The formation-burst black-box recipes cover the
// server side and WS delivery; this covers the browser-side logic those
// recipes cannot reach (their clients are raw WS sockets).
describe('group formation burst simulation', () => {
    it.each([
        { tier: 'small', memberCount: 6 },
        { tier: 'medium', memberCount: 20 },
        { tier: 'large', memberCount: 50 },
    ])(
        'adopts the server overlay on every client with bounded dials ($tier, N=$memberCount)',
        async ({ memberCount }) => {
            resetOverlayAdoptionDiagnostics();
            const sessionIds = Array.from(
                { length: memberCount },
                (_, index) => `session-${index}`,
            );
            const group = createGroupSnapshot('burst-group', 3, sessionIds);
            const overlayId = toScopedOverlayId(group.group);
            const serverTopology = createRingTopologySnapshot(
                group,
                sessionIds,
                { groupRevision: 2, presenceRevision: 2 },
            );
            const clients = sessionIds.map((sessionId) =>
                createSimulatedClient(sessionId, sessionIds)
            );

            for (const client of clients) {
                createAndSetBootstrapOverlays([group], {
                    localSessionId: client.sessionId,
                    mode: 'bounded-bootstrap',
                    bootstrapDegree: BOOTSTRAP_DEGREE,
                }, client.repositoryManager);
                await client.manager.acceptGroupUpdate(group);
            }

            for (const client of clients) {
                const bootstrapOverlay = findOverlayById(
                    overlayId,
                    client.repositoryManager,
                );
                expect(bootstrapOverlay?.provenance).toBe('bootstrap');
                expect(bootstrapOverlay?.nextHopSessionIds.length)
                    .toBeLessThanOrEqual(BOOTSTRAP_DEGREE);
                expect(client.dialedPeerIds().size)
                    .toBeLessThanOrEqual(MAX_PEER_CONNECTIONS);
            }
            expect(readOverlayAdoptionDiagnostics().initialSetCount)
                .toBe(memberCount);

            for (const client of clients) {
                setOverlayById(
                    overlayId,
                    toOverlayInfoForSession(serverTopology, client.sessionId),
                    client.repositoryManager,
                );
                await client.manager.notifyOverlayTopologyChanged();
            }

            // Belt and braces: a later legacy full-membership restamp attempt
            // must not displace the adopted server overlay on any client.
            for (const client of clients) {
                createAndSetStarOverlays([group], client.repositoryManager);
            }

            const adoption = readOverlayAdoptionDiagnostics();
            expect(adoption.serverSupersededBootstrapCount).toBe(memberCount);
            expect(adoption.bootstrapDroppedOverServerCount).toBe(memberCount);
            expect(adoption.incomparableConflictCount).toBe(0);

            for (const client of clients) {
                const adopted = findOverlayById(overlayId, client.repositoryManager);
                expect(adopted?.provenance).toBe('server');
                expect(adopted?.topology).toBe('tree');

                const dialed = client.dialedPeerIds();
                expect(dialed.size).toBeLessThanOrEqual(MAX_PEER_CONNECTIONS);
                expect(client.manager.readDiagnostics().connectFailureCount)
                    .toBe(0);
            }
        },
    );

    it('legacy-star mode reproduces the unbounded full-mesh dial storm (N=50)', async () => {
        const sessionIds = Array.from(
            { length: 50 },
            (_, index) => `session-${index}`,
        );
        const group = createGroupSnapshot('legacy-group', 3, sessionIds);
        const client = createSimulatedClient(sessionIds[0], sessionIds, {
            groupFormationMode: 'legacy-star',
        });

        createAndSetBootstrapOverlays([group], {
            localSessionId: client.sessionId,
            mode: 'legacy-star',
            bootstrapDegree: BOOTSTRAP_DEGREE,
        }, client.repositoryManager);
        await client.manager.acceptGroupUpdate(group);

        expect(client.dialedPeerIds().size).toBe(49);
    });
});

type SimulatedClient = Readonly<{
    sessionId: string;
    repositoryManager: RepositoryManager;
    manager: WebRtcGroupManager;
    dialedPeerIds: () => ReadonlySet<string>;
}>;

function createSimulatedClient(
    sessionId: string,
    allSessionIds: readonly string[],
    options: Readonly<{ groupFormationMode?: 'bounded-bootstrap' | 'legacy-star' }> =
        {},
): SimulatedClient {
    const repositoryManager = new RepositoryManager();
    configureOverlayRepository({ ttlMs: 60_000 }, repositoryManager);

    const groupCache = new LatestRepository<string, GroupSnapshot>();
    const clientCache = new LatestRepository<string, ClientInfo>();
    for (const peerSessionId of allSessionIds) {
        clientCache.set(peerSessionId, {
            clientId: peerSessionId,
            sessionId: peerSessionId,
            isOnline: true,
        });
    }

    const dialedPeerIds = new Set<string>();
    const knownPeerIds = new Set<string>();
    const rtcQBox = {
        input: { sessionId },
        knownPeerIds: () => Array.from(knownPeerIds),
        peerIdsWithNoReconnectableLanes: () => Array.from(knownPeerIds),
        ensurePeerConnectionStarted: vi.fn((peerId: string) => {
            dialedPeerIds.add(peerId);
            knownPeerIds.add(peerId);
            return Either.ofRight({ peerId } as never);
        }),
        disconnectPeer: vi.fn((peerId: string) => {
            knownPeerIds.delete(peerId);
        }),
    };

    const manager = new WebRtcGroupManager(
        rtcQBox as never,
        groupCache,
        clientCache,
        // The manager reads the same per-client overlay repository the
        // admission writes go to, exactly like the browser composition root.
        readableOverlayCache(repositoryManager),
        {
            maxPeerConnections: MAX_PEER_CONNECTIONS,
            groupFormationMode: options.groupFormationMode ?? 'bounded-bootstrap',
        },
    );

    return {
        sessionId,
        repositoryManager,
        manager,
        dialedPeerIds: () => dialedPeerIds,
    };
}

function createRingTopologySnapshot(
    group: GroupSnapshot,
    sessionIds: readonly string[],
    sourceGroupStateCausalRevision: Readonly<{
        groupRevision: number;
        presenceRevision: number;
    }>,
): RallarOverlayTopologySnapshot {
    const nextHopsBySessionId: Record<string, readonly string[]> = {};
    for (let index = 0; index < sessionIds.length; index++) {
        const previous = sessionIds[(index + sessionIds.length - 1) % sessionIds.length];
        const next = sessionIds[(index + 1) % sessionIds.length];
        nextHopsBySessionId[sessionIds[index]] = [previous, next];
    }

    return {
        sourceGroupStateCausalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        name: 'burst',
        topology: 'tree',
        activeSessionIds: sessionIds,
        nextHopsBySessionId,
        degreeLimit: BOOTSTRAP_DEGREE,
        version: 1,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
    };
}

function createGroupSnapshot(
    groupId: string,
    snapshotVersion: number,
    sessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    const ownerPrincipalId = sessionIds[0];

    return {
        stateRevision: snapshotVersion * 2,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        group: {
            applicationId,
            workspaceId,
            groupId,
            slug: null,
            displayName: groupId,
            description: null,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            maxMembers: null,
            maxSessionsPerMember: null,
            metadata: {},
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            archived: null,
            deleted: null,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
        },
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${snapshotVersion}`,
            generationVersion: snapshotVersion,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function auditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
