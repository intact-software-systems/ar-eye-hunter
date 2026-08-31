import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import { createAndSetBootstrapOverlays } from '@shared/repository/overlay-bootstrap.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    readOverlayAdoptionDiagnostics,
    resetOverlayAdoptionDiagnostics,
    setAcceptedOverlayById
} from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    describe,
    expect,
    it
} from 'vitest';
// dprint-ignore
import {
    createRingTopologySnapshot,
    createSimulatedClient,
    createSimulationGroupSnapshot
} from './group-formation-simulation-clients.ts';

const MAX_CONCURRENT_PEER_CONNECTIONS = 10;
const BOOTSTRAP_DEGREE = 5;

// The Phase 1 tier evidence for "overlay adoption ≈ 100% and concurrent
// connections bounded": N real browser-side stacks (overlay repository semantics +
// WebRtcGroupManager over a fake connection service) burst-join one group,
// bootstrap with the bounded rendezvous star, then receive an accepted server
// overlay in the traffic slot. The formation-burst black-box recipes cover the
// server side and WS delivery; this covers the browser-side logic those
// recipes cannot reach (their clients are raw WS sockets).
describe('group formation burst simulation', () => {
    it.each([
        { tier: 'small', memberCount: 6 },
        { tier: 'medium', memberCount: 20 },
        { tier: 'large', memberCount: 50 }
    ])(
        'adopts the server overlay on every client with bounded concurrent connections ($tier, N=$memberCount)',
        async ({ memberCount }) => {
            resetOverlayAdoptionDiagnostics();
            const sessionIds = Array.from(
                { length: memberCount },
                (_, index) => `session-${index}`
            );
            const group = createSimulationGroupSnapshot('burst-group', 3, sessionIds);
            const overlayId = toScopedOverlayId(group.group);
            const serverTopology = createRingTopologySnapshot(
                group,
                sessionIds,
                {
                    sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
                    version: 1,
                    degreeLimit: BOOTSTRAP_DEGREE
                }
            );
            const clients = sessionIds.map((sessionId) =>
                createSimulatedClient(sessionId, sessionIds, {
                    maxPeerConnections: MAX_CONCURRENT_PEER_CONNECTIONS
                })
            );

            for (const client of clients) {
                createAndSetBootstrapOverlays([group], {
                    localSessionId: client.sessionId,
                    bootstrapDegree: BOOTSTRAP_DEGREE
                }, client.repositoryManager);
                await client.manager.acceptGroupUpdate(group);
            }

            for (const client of clients) {
                const bootstrapOverlay = findPlannedOverlayById(
                    overlayId,
                    client.repositoryManager
                );
                expect(bootstrapOverlay?.provenance).toBe('bootstrap');
                expect(bootstrapOverlay?.nextHopSessionIds.length)
                    .toBeLessThanOrEqual(BOOTSTRAP_DEGREE);
                expect(client.connectedPeerIds().size)
                    .toBeLessThanOrEqual(MAX_CONCURRENT_PEER_CONNECTIONS);
            }
            expect(readOverlayAdoptionDiagnostics().initialSetCount)
                .toBe(memberCount);

            for (const client of clients) {
                setAcceptedOverlayById(
                    overlayId,
                    toOverlayInfoForSession(serverTopology, client.sessionId),
                    client.repositoryManager
                );
                await client.manager.notifyOverlayTopologyChanged();
            }

            const adoption = readOverlayAdoptionDiagnostics();
            expect(adoption.initialSetCount).toBe(memberCount * 2);
            expect(adoption.serverSupersededBootstrapCount).toBe(0);
            expect(adoption.bootstrapDroppedOverServerCount).toBe(0);
            expect(adoption.incomparableConflictCount).toBe(0);

            for (const client of clients) {
                const adopted = findAcceptedOverlayById(overlayId, client.repositoryManager);
                expect(adopted?.provenance).toBe('server');
                expect(adopted?.topology).toBe('tree');
                expect(findPlannedOverlayById(overlayId, client.repositoryManager)?.provenance)
                    .toBe('bootstrap');

                expect(client.connectedPeerIds().size)
                    .toBeLessThanOrEqual(MAX_CONCURRENT_PEER_CONNECTIONS);
                expect(client.manager.readDiagnostics().connectFailureCount)
                    .toBe(0);
            }
        }
    );
});
