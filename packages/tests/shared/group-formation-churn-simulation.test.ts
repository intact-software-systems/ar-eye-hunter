import { describe, expect, it } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import {
    resetOverlayAdoptionDiagnostics,
    setOverlayById,
} from '@shared/repository/overlays-repository.ts';
import {
    createRingTopologySnapshot,
    createSimulatedClient,
    createSimulationGroupSnapshot,
    type SimulatedClient,
} from './group-formation-simulation-clients.ts';

const MAX_PEER_CONNECTIONS = 10;
const MEMBER_COUNT = 50;
const DEGREE_LIMIT = 5;

// Phase 4 slice-1 churn instrument: N real browser-side stacks (overlay
// repository semantics + WebRtcGroupManager over a fake connection service)
// hold a formed server overlay, then receive replacement overlay epochs. The
// per-client dial/teardown deltas measure exactly how much edge churn the
// browser executes per overlay transition — the browser follows the planned
// edge delta one-to-one, so planner-side churn (measured separately against
// the planning kernel) composes with these numbers into the end-to-end
// churn-per-membership-change quantity the phase-4 acceptance bounds.
describe('group formation churn simulation', () => {
    it('republishing an identical edge set churns zero edges on every client (N=50)', async () => {
        const formed = await createFormedClients();

        const republished = createRingTopologySnapshot(formed.group, formed.sessionIds, {
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
            version: 2,
            degreeLimit: DEGREE_LIMIT,
            ringShift: 1,
        });
        for (const client of formed.clients) {
            setOverlayById(
                formed.overlayId,
                toOverlayInfoForSession(republished, client.sessionId),
                client.repositoryManager,
            );
            await client.manager.notifyOverlayTopologyChanged();
        }

        for (const client of formed.clients) {
            const diagnostics = client.manager.readDiagnostics();
            expect(diagnostics.connectAttemptCount).toBe(formed.formationDialCount);
            expect(diagnostics.disconnectCount).toBe(0);
        }
    });

    it('an overlay transition dials its edge delta but retains outgoing edges for the grace window (N=50)', async () => {
        const formed = await createFormedClients();

        const reshuffled = createRingTopologySnapshot(formed.group, formed.sessionIds, {
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
            version: 2,
            degreeLimit: DEGREE_LIMIT,
            ringShift: 7,
        });
        for (const client of formed.clients) {
            setOverlayById(
                formed.overlayId,
                toOverlayInfoForSession(reshuffled, client.sessionId),
                client.repositoryManager,
            );
            await client.manager.notifyOverlayTopologyChanged();
        }

        for (const client of formed.clients) {
            const diagnostics = client.manager.readDiagnostics();
            // Shift-1 and shift-7 next-hop sets are disjoint: two edges in per
            // client are dialed, but the two outgoing edges the previous epoch
            // wanted survive as retained connections instead of being torn
            // down in the same pass (M11 grace window).
            expect(diagnostics.connectAttemptCount - formed.formationDialCount).toBe(2);
            expect(diagnostics.disconnectCount).toBe(0);
            expect(diagnostics.retainedCreatedCount).toBe(2);
            expect(diagnostics.retainedExpiredCount).toBe(0);
            expect(client.connectedPeerIds().size).toBeLessThanOrEqual(MAX_PEER_CONNECTIONS);
        }
    });

    it('a flapping overlay converges to zero churn inside the grace window (N=50)', async () => {
        const formed = await createFormedClients();

        const reshuffled = createRingTopologySnapshot(formed.group, formed.sessionIds, {
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
            version: 2,
            degreeLimit: DEGREE_LIMIT,
            ringShift: 7,
        });
        const revertedToFormedEdges = createRingTopologySnapshot(formed.group, formed.sessionIds, {
            sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: 3 },
            version: 3,
            degreeLimit: DEGREE_LIMIT,
            ringShift: 1,
        });
        for (const client of formed.clients) {
            for (const epoch of [reshuffled, revertedToFormedEdges]) {
                setOverlayById(
                    formed.overlayId,
                    toOverlayInfoForSession(epoch, client.sessionId),
                    client.repositoryManager,
                );
                await client.manager.notifyOverlayTopologyChanged();
            }
        }

        for (const client of formed.clients) {
            const diagnostics = client.manager.readDiagnostics();
            // The flap's second epoch wants the original edges back: they are
            // still connected (retained through the grace window), so the
            // round trip costs the two forward dials and zero teardowns —
            // flapping converges instead of looping.
            expect(diagnostics.connectAttemptCount - formed.formationDialCount).toBe(2);
            expect(diagnostics.disconnectCount).toBe(0);
            expect(diagnostics.retainedExpiredCount).toBe(0);
        }
    });

    it('retained transition edges expire after the grace window and tear down budget-free (N=50)', async () => {
        let nowEpochMs = 1_000;
        const formed = await createFormedClients({
            overlayTransitionGraceMs: 5_000,
            now: () => nowEpochMs,
        });

        const reshuffled = createRingTopologySnapshot(formed.group, formed.sessionIds, {
            sourceGroupStateCausalRevision: { groupRevision: 2, presenceRevision: 2 },
            version: 2,
            degreeLimit: DEGREE_LIMIT,
            ringShift: 7,
        });
        for (const client of formed.clients) {
            setOverlayById(
                formed.overlayId,
                toOverlayInfoForSession(reshuffled, client.sessionId),
                client.repositoryManager,
            );
            await client.manager.notifyOverlayTopologyChanged();
        }

        nowEpochMs += 6_000;
        for (const client of formed.clients) {
            await client.manager.ensureAllGroupsConnected();
        }

        for (const client of formed.clients) {
            const diagnostics = client.manager.readDiagnostics();
            expect(diagnostics.retainedCreatedCount).toBe(2);
            expect(diagnostics.retainedExpiredCount).toBe(2);
            expect(diagnostics.disconnectCount).toBe(2);
            expect(client.connectedPeerIds().size).toBeLessThanOrEqual(MAX_PEER_CONNECTIONS);
        }
    });
});

type FormedClients = Readonly<{
    group: ReturnType<typeof createSimulationGroupSnapshot>;
    sessionIds: readonly string[];
    overlayId: string;
    clients: readonly SimulatedClient[];
    formationDialCount: number;
}>;

type FormedClientOptions = Readonly<{
    overlayTransitionGraceMs?: number;
    now?: () => number;
}>;

async function createFormedClients(options: FormedClientOptions = {}): Promise<FormedClients> {
    resetOverlayAdoptionDiagnostics();
    const sessionIds = Array.from(
        { length: MEMBER_COUNT },
        (_, index) => `session-${String(index).padStart(2, '0')}`,
    );
    const group = createSimulationGroupSnapshot('churn-group', 1, sessionIds);
    const overlayId = toScopedOverlayId(group.group);
    const formedTopology = createRingTopologySnapshot(group, sessionIds, {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 1 },
        version: 1,
        degreeLimit: DEGREE_LIMIT,
        ringShift: 1,
    });

    const clients = sessionIds.map((sessionId) =>
        createSimulatedClient(sessionId, sessionIds, {
            maxPeerConnections: MAX_PEER_CONNECTIONS,
            ...options,
        })
    );
    for (const client of clients) {
        setOverlayById(
            overlayId,
            toOverlayInfoForSession(formedTopology, client.sessionId),
            client.repositoryManager,
        );
        await client.manager.acceptGroupUpdate(group);
    }

    const formationDialCount = clients[0].manager.readDiagnostics().connectAttemptCount;
    for (const client of clients) {
        expect(client.manager.readDiagnostics().connectAttemptCount).toBe(formationDialCount);
        expect(client.manager.readDiagnostics().disconnectCount).toBe(0);
    }

    return { group, sessionIds, overlayId, clients, formationDialCount };
}
