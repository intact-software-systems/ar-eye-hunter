import { beforeEach, describe, expect, it } from 'vitest';

import type { RallarRoomFormationStatus, RallarRoomLayoutEvent } from '@shared-web/browser/rallar.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    configureOverlayRepositories,
    removePlannedOverlayById,
    setPlannedOverlayById,
    waitForPlannedOverlayChangesIdle
} from '@shared/repository/overlays-repository.ts';

import { publishRoomSnapshots, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

describe('room formation subscriptions', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    });

    it('emits the current status once, then only observable changes', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const seen: RallarRoomFormationStatus[] = [];
        const stop = createRallarFacade().rooms.formation(planned.group).onChange((status) => {
            seen.push(status);
        });

        await publishRoomSnapshots([planned]);
        setPlannedOverlayById(
            toScopedOverlayId(planned.group),
            createLayoutOverlay({
                roomRef: planned.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );
        await waitForPlannedOverlayChangesIdle();
        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        ]);
        stop();
        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'active',
                formationEpoch: 3,
                causalRevision: { groupRevision: 4, presenceRevision: 1 }
            })
        ]);

        expect(seen.map((status) => [status.stage, status.planned?.identity.version])).toEqual([
            ['planned', undefined],
            ['planned', 2],
            ['connecting', 2]
        ]);
    });

    it('reports planned, accepted and removed layouts for the bound room only', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const room = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        const other = { ...room.group, groupId: 'room-2' };
        seedRoomSnapshots([room]);
        const events: RallarRoomLayoutEvent[] = [];
        createRallarFacade().rooms.formation(room.group).onLayout((event) => {
            events.push(event);
        });

        setPlannedOverlayById(
            toScopedOverlayId(other),
            createLayoutOverlay({
                roomRef: other,
                causalRevision: { groupRevision: 9, presenceRevision: 9 },
                version: 9
            })
        );
        setPlannedOverlayById(
            toScopedOverlayId(room.group),
            createLayoutOverlay({
                roomRef: room.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );
        removePlannedOverlayById(toScopedOverlayId(room.group));
        await waitForPlannedOverlayChangesIdle();

        expect(events.map((event) => event.kind)).toEqual(['layoutPlanned', 'layoutRemoved']);
        expect(events[1]).toMatchObject({ role: 'planned', previous: { identity: { version: 2 } } });
    });
});
