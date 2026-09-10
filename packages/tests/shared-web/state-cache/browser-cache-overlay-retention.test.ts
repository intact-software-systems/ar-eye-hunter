import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialiseBrowserCacheRepositories } from '@shared-web/browser/state-cache/initialise-browser-cache-repositories.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { defaultRepositoryManager } from '@shared/cache/defaultRepositoryManager.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    setCurrentAcceptedServerOverlayById,
    setCurrentPlannedServerOverlayById
} from '@shared/repository/overlays-repository.ts';

const roomRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

describe('browser cache overlay retention', () => {
    beforeEach(async () => {
        await defaultRepositoryManager.clear();
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        initialiseBrowserCacheRepositories();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('retains the accepted layout for the connection lifecycle while planned work expires', () => {
        const overlay = createOverlay();
        setCurrentAcceptedServerOverlayById(overlay.overlayId, overlay);
        setCurrentPlannedServerOverlayById(overlay.overlayId, overlay);

        vi.setSystemTime(61_001);

        expect(findAcceptedOverlayById(overlay.overlayId)).toEqual(overlay);
        expect(findPlannedOverlayById(overlay.overlayId)).toBeUndefined();
    });
});

function createOverlay(): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 1,
            presenceRevision: 1
        },
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
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}
