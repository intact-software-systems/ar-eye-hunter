import { beforeEach, describe, expect, it } from 'vitest';

import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';

import { publishRoomSnapshots, resetRoomWorkflowTestRuntime, seedRoomSnapshots } from '../room-workflow-test-runtime.ts';
import { createFormationSnapshot } from './room-formation-test-fixtures.ts';

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
