import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    configureOverlayRepositories,
    findAcceptedOverlayById,
    findPlannedOverlayById,
    onAcceptedOverlayChange,
    onPlannedOverlayChange,
    removeAcceptedOverlayById,
    removeAcceptedOverlayByIdIfUnchanged,
    removePlannedOverlayById,
    removePlannedOverlayByIdIfUnchanged,
    setAcceptedOverlayById,
    setCurrentAcceptedServerOverlayById,
    setCurrentPlannedServerOverlayById,
    setPlannedOverlayById,
    waitForAcceptedOverlayChangesIdle,
    waitForPlannedOverlayChangesIdle
} from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

describe('overlay repository roles', () => {
    beforeEach(() => {
        configureOverlayRepositories({
            plannedOverlays: { ttlMs: 60_000 },
            acceptedOverlays: { ttlMs: 60_000 }
        });
    });

    it('stores planned and accepted layouts independently under the canonical wire overlay id', () => {
        const accepted = overlay({ version: 2, nextHopSessionIds: ['accepted-peer'] });
        const planned = overlay({ version: 3, nextHopSessionIds: ['planned-peer'] });

        expect(setAcceptedOverlayById(accepted.overlayId, accepted)).toBe('initial-set');
        expect(setPlannedOverlayById(planned.overlayId, planned)).toBe('initial-set');

        expect(findAcceptedOverlayById(accepted.overlayId)).toEqual(accepted);
        expect(findPlannedOverlayById(planned.overlayId)).toEqual(planned);
        expect(findAcceptedOverlayById(accepted.overlayId)?.overlayId).toBe(accepted.overlayId);
        expect(findPlannedOverlayById(planned.overlayId)?.overlayId).toBe(planned.overlayId);
    });

    it('reports conflicts as non-fatal adoption outcomes and lets fresh current state replace incomparability', () => {
        const historical = overlay({
            groupRevision: 4,
            presenceRevision: 6,
            version: 7,
            nextHopSessionIds: ['historical-peer']
        });
        const incomparablePublication = overlay({
            groupRevision: 5,
            presenceRevision: 5,
            version: 8,
            nextHopSessionIds: ['publication-peer']
        });
        const durableCurrent = overlay({
            groupRevision: 5,
            presenceRevision: 5,
            version: 8,
            nextHopSessionIds: ['current-peer']
        });

        setPlannedOverlayById(historical.overlayId, historical);

        expect(setPlannedOverlayById(incomparablePublication.overlayId, incomparablePublication))
            .toBe('incomparable-conflict');
        expect(findPlannedOverlayById(historical.overlayId)).toEqual(historical);

        expect(setCurrentPlannedServerOverlayById(durableCurrent.overlayId, durableCurrent))
            .toBe('adopted');
        expect(findPlannedOverlayById(durableCurrent.overlayId)).toEqual(durableCurrent);
    });

    it('exposes independent role change and idle boundaries', async () => {
        const roleChanges: string[] = [];
        const plannedOverlayIds: string[] = [];
        const acceptedOverlayIds: string[] = [];
        const unsubscribePlanned = onPlannedOverlayChange((change) => {
            roleChanges.push(`planned:${change.kind}`);
            plannedOverlayIds.push(change.overlayId);
        });
        const unsubscribeAccepted = onAcceptedOverlayChange((change) => {
            roleChanges.push(`accepted:${change.kind}`);
            acceptedOverlayIds.push(change.overlayId);
        });

        try {
            const planned = overlay({ version: 1 });
            const accepted = overlay({ version: 2 });
            setPlannedOverlayById(planned.overlayId, planned);
            setAcceptedOverlayById(accepted.overlayId, accepted);
            removePlannedOverlayById(planned.overlayId);
            removeAcceptedOverlayById(accepted.overlayId);
            await Promise.all([
                waitForPlannedOverlayChangesIdle(),
                waitForAcceptedOverlayChangesIdle()
            ]);

            expect(roleChanges).toEqual([
                'planned:created',
                'accepted:created',
                'planned:deleted',
                'accepted:deleted'
            ]);
            const canonicalOverlayId = toScopedOverlayId(planned.groupRef);
            expect(plannedOverlayIds).toEqual([canonicalOverlayId, canonicalOverlayId]);
            expect(acceptedOverlayIds).toEqual([canonicalOverlayId, canonicalOverlayId]);
            expect(canonicalOverlayId).not.toContain(':planned');
            expect(canonicalOverlayId).not.toContain(':accepted');
        }
        finally {
            unsubscribePlanned();
            unsubscribeAccepted();
        }
    });

    it.each([
        { role: 'planned publication', write: setPlannedOverlayById, read: findPlannedOverlayById },
        { role: 'accepted publication', write: setAcceptedOverlayById, read: findAcceptedOverlayById },
        { role: 'planned current', write: setCurrentPlannedServerOverlayById, read: findPlannedOverlayById },
        { role: 'accepted current', write: setCurrentAcceptedServerOverlayById, read: findAcceptedOverlayById }
    ])('retires the same layout tuple and rejects reverse delivery in $role', ({ write, read }) => {
        const active = overlay({ version: 3, nextHopSessionIds: ['peer'] });
        const removed: OverlayInfo = { ...active, state: 'removed', nextHopSessionIds: [] };
        expect(write(active.overlayId, active)).toBe('initial-set');
        expect(write(removed.overlayId, removed)).toBe('adopted');
        expect(read(active.overlayId)).toBeUndefined();
        expect(write(active.overlayId, active)).toBe('dominated-dropped');
        expect(read(active.overlayId)).toBeUndefined();
        expect(write(removed.overlayId, removed)).toBe('equal');
        expect(write(removed.overlayId, { ...removed, name: 'divergent' }))
            .toBe('incomparable-conflict');
    });

    it('conditionally removes each role only while its exact observation remains current', () => {
        const planned = overlay({ version: 1, nextHopSessionIds: ['planned-peer'] });
        const accepted = overlay({ version: 1, nextHopSessionIds: ['accepted-peer'] });
        setPlannedOverlayById(planned.overlayId, planned);
        setAcceptedOverlayById(accepted.overlayId, accepted);

        const plannedObservation = findPlannedOverlayById(planned.overlayId);
        const acceptedObservation = findAcceptedOverlayById(accepted.overlayId);
        const newerPlanned = overlay({ version: 2, nextHopSessionIds: ['new-planned-peer'] });
        setPlannedOverlayById(newerPlanned.overlayId, newerPlanned);

        expect(removePlannedOverlayByIdIfUnchanged(planned.overlayId, plannedObservation)).toBe(false);
        expect(removeAcceptedOverlayByIdIfUnchanged(accepted.overlayId, acceptedObservation)).toBe(true);
        expect(findPlannedOverlayById(planned.overlayId)).toEqual(newerPlanned);
        expect(findAcceptedOverlayById(accepted.overlayId)).toBeUndefined();
    });
});

interface OverlayFixtureInput {
    readonly groupRevision?: number;
    readonly presenceRevision?: number;
    readonly version: number;
    readonly nextHopSessionIds?: readonly string[];
}

function overlay(input: OverlayFixtureInput): OverlayInfo {
    const groupRef = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1'
    };
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: input.groupRevision ?? input.version,
            presenceRevision: input.presenceRevision ?? input.version
        },
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        topology: 'tree',
        name: 'Room',
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...(input.nextHopSessionIds ?? [])],
        degreeLimit: 5,
        overlayVersion: input.version,
        updatedAtEpochMs: input.version
    };
}
