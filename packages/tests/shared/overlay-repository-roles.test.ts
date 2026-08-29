import type { OverlayInfo } from '@shared/api/api-config.ts';
import {
    configureOverlayRepositories,
    findAcceptedOverlayById,
    findPlannedOverlayById,
    onAcceptedOverlayChange,
    onPlannedOverlayChange,
    removeAcceptedOverlayById,
    removePlannedOverlayById,
    setAcceptedOverlayById,
    setCurrentPlannedServerOverlayById,
    setPlannedOverlayById,
    waitForAcceptedOverlayChangesIdle,
    waitForPlannedOverlayChangesIdle
} from '@shared/repository/overlays-repository.ts';
import { beforeEach, describe, expect, it } from 'vitest';

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
        expect(findAcceptedOverlayById(accepted.overlayId)?.overlayId).toBe('canonical-overlay-id');
        expect(findPlannedOverlayById(planned.overlayId)?.overlayId).toBe('canonical-overlay-id');
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
        const unsubscribePlanned = onPlannedOverlayChange((change) => {
            roleChanges.push(`planned:${change.kind}`);
        });
        const unsubscribeAccepted = onAcceptedOverlayChange((change) => {
            roleChanges.push(`accepted:${change.kind}`);
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
        }
        finally {
            unsubscribePlanned();
            unsubscribeAccepted();
        }
    });
});

interface OverlayFixtureInput {
    readonly groupRevision?: number;
    readonly presenceRevision?: number;
    readonly version: number;
    readonly nextHopSessionIds?: readonly string[];
}

function overlay(input: OverlayFixtureInput): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: input.groupRevision ?? input.version,
            presenceRevision: input.presenceRevision ?? input.version
        },
        provenance: 'server',
        state: 'active',
        overlayId: 'canonical-overlay-id',
        groupRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1'
        },
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
