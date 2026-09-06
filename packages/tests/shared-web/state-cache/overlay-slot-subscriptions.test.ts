import { beforeEach, describe, expect, it } from 'vitest';

import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    configureOverlayRepositories,
    setAcceptedOverlayById,
    setPlannedOverlayById,
    waitForAcceptedOverlayChangesIdle,
    waitForPlannedOverlayChangesIdle
} from '@shared/repository/overlays-repository.ts';

import {
    rebindOverlaySlotSubscriptions,
    subscribeOverlaySlot
} from '@shared-web/browser/state-cache/overlay-slot-subscriptions.ts';

const roomRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

function configureRepositories(): void {
    configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    rebindOverlaySlotSubscriptions();
}

function createOverlay(version: number): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: version, presenceRevision: 1 },
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(roomRef),
        groupRef: roomRef,
        topology: 'tree',
        name: roomRef.groupId,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: ['peer-a'],
        degreeLimit: 2,
        overlayVersion: version,
        updatedAtEpochMs: 1
    };
}

describe('overlay slot subscriptions', () => {
    beforeEach(async () => {
        await defaultRepositoryManager.clear();
    });

    it('holds a listener registered before the repositories exist and binds it at configuration', async () => {
        const seen: number[] = [];
        const unsubscribe = subscribeOverlaySlot('planned', (change) => {
            seen.push(change.overlay?.overlayVersion ?? -1);
        });

        configureRepositories();
        setPlannedOverlayById(toScopedOverlayId(roomRef), createOverlay(1));
        await waitForPlannedOverlayChangesIdle();
        unsubscribe();

        expect(seen).toEqual([1]);
    });

    it('keeps delivering after the repositories are replaced by a reconfiguration', async () => {
        configureRepositories();
        const seen: number[] = [];
        const unsubscribe = subscribeOverlaySlot('accepted', (change) => {
            seen.push(change.overlay?.overlayVersion ?? -1);
        });
        setAcceptedOverlayById(toScopedOverlayId(roomRef), createOverlay(1));
        await waitForAcceptedOverlayChangesIdle();

        configureRepositories();
        setAcceptedOverlayById(toScopedOverlayId(roomRef), createOverlay(2));
        await waitForAcceptedOverlayChangesIdle();
        unsubscribe();

        expect(seen).toEqual([1, 2]);
    });

    it('stops delivering once unsubscribed, before and after a reconfiguration', async () => {
        configureRepositories();
        const seen: number[] = [];
        const unsubscribe = subscribeOverlaySlot('planned', (change) => {
            seen.push(change.overlay?.overlayVersion ?? -1);
        });
        unsubscribe();
        setPlannedOverlayById(toScopedOverlayId(roomRef), createOverlay(1));
        await waitForPlannedOverlayChangesIdle();

        configureRepositories();
        setPlannedOverlayById(toScopedOverlayId(roomRef), createOverlay(2));
        await waitForPlannedOverlayChangesIdle();

        expect(seen).toEqual([]);
    });
});
