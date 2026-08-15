import { describe, expect, it } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import {
    createAndSetBootstrapOverlays,
} from '@shared/repository/overlay-bootstrap.ts';
import {
    createAndSetStarOverlays,
    findOverlayById,
    readOverlayAdoptionDiagnostics,
    resetOverlayAdoptionDiagnostics,
    setOverlayById,
} from '@shared/repository/overlays-repository.ts';
import {
    createRingTopologySnapshot,
    createSimulatedClient,
    createSimulationGroupSnapshot,
} from './group-formation-simulation-clients.ts';

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
            const group = createSimulationGroupSnapshot('burst-group', 3, sessionIds);
            const overlayId = toScopedOverlayId(group.group);
            const serverTopology = createRingTopologySnapshot(
                group,
                sessionIds,
                {
                    sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
                    version: 1,
                    degreeLimit: BOOTSTRAP_DEGREE,
                },
            );
            const clients = sessionIds.map((sessionId) =>
                createSimulatedClient(sessionId, sessionIds, {
                    maxPeerConnections: MAX_PEER_CONNECTIONS,
                })
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
        const group = createSimulationGroupSnapshot('legacy-group', 3, sessionIds);
        const client = createSimulatedClient(sessionIds[0], sessionIds, {
            groupFormationMode: 'legacy-star',
            maxPeerConnections: MAX_PEER_CONNECTIONS,
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
