import { beforeEach, describe, expect, it } from 'vitest';

import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
    configureOverlayRepositories,
    setAcceptedOverlayById,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';

import { publishRoomSnapshots, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot, createLayoutOverlay } from './room-formation-test-fixtures.ts';

describe('room formation stage and condition waits', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    });

    it('resolves immediately when the cached stage already matches', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);

        const result = await createRallarFacade().rooms.formation(planned.group).waitForStage(
            ['planned', 'connecting'],
            { timeoutMs: 10 }
        );

        expect(result.status).toBe('ready');
        expect(result.formation?.stage).toBe('planned');
    });

    it('resolves on a later cache change and times out otherwise', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const planned = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([planned]);
        const formation = createRallarFacade().rooms.formation(planned.group);
        const wait = formation.waitForStage('connecting', { timeoutMs: 1_000 });

        await publishRoomSnapshots([
            createFormationSnapshot({
                stage: 'connecting',
                formationEpoch: 2,
                causalRevision: { groupRevision: 3, presenceRevision: 1 }
            })
        ]);

        await expect(wait).resolves.toMatchObject({ status: 'ready', formation: { stage: 'connecting', formationEpoch: 2 } });
        await expect(formation.waitForStage('active', { timeoutMs: 10 })).resolves.toMatchObject({
            status: 'timeout',
            formation: { stage: 'connecting' }
        });
    });

    it('reports not-found for a room that is not cached and aborted on an aborted signal', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const missing = createFormationSnapshot({
            stage: 'forming',
            formationEpoch: 0,
            causalRevision: { groupRevision: 1, presenceRevision: 1 }
        });
        const controller = new AbortController();
        controller.abort();

        await expect(
            createRallarFacade().rooms.formation(missing.group).waitForStage('active', { timeoutMs: 10 })
        ).resolves.toMatchObject({ status: 'not-found', formation: undefined });
        seedRoomSnapshots([missing]);
        await expect(
            createRallarFacade().rooms.formation(missing.group).waitForStage('active', { signal: controller.signal })
        ).resolves.toMatchObject({ status: 'aborted' });
    });

    it('waits for the pushed activation condition', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const connecting = createFormationSnapshot({
            stage: 'connecting',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        seedRoomSnapshots([connecting]);
        const wait = createRallarFacade().rooms.formation(connecting.group).waitForCondition('active', {
            timeoutMs: 1_000
        });
        const status = {
            condition: 'active' as const,
            coverageRate: 1,
            coverageBasisLayoutIdentity: { groupRevision: 3, presenceRevision: 1, version: 2, state: 'active' as const },
            formationEpoch: 2,
            evidenceWatermark: null,
            publishedAtEpochMs: 5
        };

        await publishRoomSnapshots([{ ...connecting, group: { ...connecting.group, activationStatus: status } }]);

        await expect(wait).resolves.toMatchObject({ status: 'ready', formation: { condition: 'active', coverageRate: 1 } });
    });
});

describe('room formation layout waits', () => {
    beforeEach(() => {
        resetRoomWorkflowTestRuntime();
        configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    });

    it('resolves when a planned layout at or after the fence lands in the slot', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const receipt = createFormationSnapshot({
            stage: 'planned',
            formationEpoch: 1,
            causalRevision: { groupRevision: 2, presenceRevision: 1 }
        });
        seedRoomSnapshots([receipt]);
        const overlayId = toScopedOverlayId(receipt.group);
        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 1, presenceRevision: 1 },
                version: 1
            })
        );
        const wait = createRallarFacade().rooms.formation(receipt.group).waitForLayout({
            after: receipt.causalRevision,
            timeoutMs: 1_000
        });

        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 2, presenceRevision: 1 },
                version: 2
            })
        );

        await expect(wait).resolves.toMatchObject({
            status: 'ready',
            layout: {
                role: 'planned',
                identity: { groupRevision: 2, presenceRevision: 1, version: 2, state: 'active' }
            }
        });
    });

    it('refuses a dominated or incomparable layout under a fence but accepts any layout without one', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const receipt = createFormationSnapshot({
            stage: 'reconfiguring',
            formationEpoch: 3,
            causalRevision: { groupRevision: 5, presenceRevision: 3 }
        });
        seedRoomSnapshots([receipt]);
        const overlayId = toScopedOverlayId(receipt.group);
        const formation = createRallarFacade().rooms.formation(receipt.group);
        setPlannedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: receipt.group,
                causalRevision: { groupRevision: 4, presenceRevision: 3 },
                version: 4
            })
        );

        await expect(formation.waitForLayout({ after: receipt.causalRevision, timeoutMs: 10 })).resolves.toMatchObject({
            status: 'timeout',
            layout: undefined
        });
        await expect(
            formation.waitForLayout({ after: { groupRevision: 6, presenceRevision: 1 }, timeoutMs: 10 })
        ).resolves.toMatchObject({ status: 'timeout' });
        await expect(formation.waitForLayout({ timeoutMs: 10 })).resolves.toMatchObject({
            status: 'ready',
            layout: { identity: { version: 4 } }
        });
    });

    it('waits for the accepted role against the snapshot identity', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const connecting = createFormationSnapshot({
            stage: 'connecting',
            formationEpoch: 2,
            causalRevision: { groupRevision: 3, presenceRevision: 1 }
        });
        seedRoomSnapshots([connecting]);
        const overlayId = toScopedOverlayId(connecting.group);
        const wait = createRallarFacade().rooms.formation(connecting.group).waitForLayout({
            role: 'accepted',
            timeoutMs: 1_000
        });
        const identity = { groupRevision: 3, presenceRevision: 1, version: 2, state: 'active' as const };

        setAcceptedOverlayById(
            overlayId,
            createLayoutOverlay({
                roomRef: connecting.group,
                causalRevision: { groupRevision: 3, presenceRevision: 1 },
                version: 2
            })
        );
        await publishRoomSnapshots([{
            ...connecting,
            group: {
                ...connecting.group,
                lifecycleState: 'active',
                formationEpoch: 3,
                acceptedLayoutIdentity: identity
            }
        }]);

        await expect(wait).resolves.toMatchObject({ status: 'ready', layout: { role: 'accepted', identity } });
    });
});
