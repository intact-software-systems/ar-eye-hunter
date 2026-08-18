import { describe, expect, it } from 'vitest';
import { createRecipeConsoleControlScaleFixture } from
    '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';
import type { RecipeConsoleControlQueryProvenance } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import {
    createRecipeConsoleHistoryCollection,
    deriveRecipeConsoleHistoryWindow,
    RECIPE_CONSOLE_HISTORY_WINDOW_SIZE,
} from '../../../apps/rallar-black-box/src/recipe-console/history/history-model.ts';
import type { ControlServerSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

function query(
    snapshot: ControlServerSnapshot,
    source: RecipeConsoleControlQueryProvenance['distributedRunsSource'] =
        'root-snapshot',
): ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance> {
    return {
        status: 'live',
        reachability: 'reachable',
        authorization: 'ready',
        snapshot,
        completeness: 'complete',
        provenance: {
            distributedRunsSource: source,
            runEvidence: { detailedRunIds: [], indexOnlyRunIds: [] },
        },
        receivedAtEpochMs: 2_000_000_000_001,
        isRefreshing: false,
    };
}

describe('Recipe Console History explicit window', () => {
    it('traverses all 5,000 pairs with absolute keys and bounded projection work', () => {
        const fixture = createRecipeConsoleControlScaleFixture();
        const collection = createRecipeConsoleHistoryCollection({
            query: query(fixture.snapshot),
            urlState: { v: 1, experience: 'recipe-console', view: 'tune' },
        });

        expect(RECIPE_CONSOLE_HISTORY_WINDOW_SIZE).toBe(80);
        expect(collection.counts).toEqual({ available: 5_000, total: 5_000 });
        expect(collection.work).toEqual({
            controlRunVisits: 5_000,
            distributedRunVisits: 5_000,
        });

        const visitedIds: string[] = [];
        const visitedKeys: string[] = [];
        for (let startIndex = 0; startIndex < collection.counts.total;
            startIndex += RECIPE_CONSOLE_HISTORY_WINDOW_SIZE) {
            const model = deriveRecipeConsoleHistoryWindow(collection, startIndex);
            visitedIds.push(...model.rows.map(row => row.distributedRunId));
            visitedKeys.push(...model.rows.map(row => row.key));
            expect(model.rows.length).toBeLessThanOrEqual(80);
            expect(model.work).toEqual({
                projectedRows: model.rows.length,
                labelProjections: model.rows.length,
                catalogRunProjections: model.rows.length,
                actionProjections: model.rows.length,
                controlAgentVisits: model.rows.length,
            });
        }

        expect(visitedIds).toEqual(
            fixture.snapshot.distributedRuns.map(run => run.distributedRunId),
        );
        expect(visitedKeys).toEqual(
            Array.from({ length: 5_000 }, (_, index) => `history-row:${index}`),
        );
        expect(new Set(visitedIds).size).toBe(5_000);
        expect(visitedIds.at(-1)).toBe(fixture.needles.distributedRunIds.last);
    });

    it('does not touch off-window manifest or agent projections without filters', () => {
        const fixture = createRecipeConsoleControlScaleFixture({ pairCount: 161 });
        const outsideRun = fixture.snapshot.distributedRuns[0]!;
        const outsideControl = fixture.snapshot.runs[0]!;
        Object.defineProperty(outsideRun, 'manifest', {
            configurable: true,
            get: () => {
                throw new Error('History touched an off-window manifest projection.');
            },
        });
        Object.defineProperty(outsideControl, 'agents', {
            configurable: true,
            get: () => {
                throw new Error('History touched an off-window agent projection.');
            },
        });

        const collection = createRecipeConsoleHistoryCollection({
            query: query(fixture.snapshot),
            urlState: { v: 1, experience: 'recipe-console', view: 'tune' },
        });
        const model = deriveRecipeConsoleHistoryWindow(collection, 80);

        expect(model.rows).toHaveLength(80);
        expect(model.rows[0]?.key).toBe('history-row:80');
        expect(model.work).toMatchObject({
            projectedRows: 80,
            labelProjections: 80,
            catalogRunProjections: 80,
            controlAgentVisits: 80,
        });
    });

    it('applies global duplicate and control ambiguity to the visible window', () => {
        const fixture = createRecipeConsoleControlScaleFixture({ pairCount: 161 });
        const visibleDuplicate = fixture.snapshot.distributedRuns[80]!;
        const outsideDuplicate = fixture.snapshot.distributedRuns[160]!;
        const visibleAmbiguous = fixture.snapshot.distributedRuns[81]!;
        const duplicateControl = structuredClone(
            fixture.snapshot.runs[81]!,
        );
        const snapshot = {
            ...fixture.snapshot,
            runs: [...fixture.snapshot.runs, duplicateControl],
            distributedRuns: fixture.snapshot.distributedRuns.map((run, index) =>
                index === 160
                    ? {
                        ...outsideDuplicate,
                        distributedRunId: visibleDuplicate.distributedRunId,
                    }
                    : run
            ),
        };

        const collection = createRecipeConsoleHistoryCollection({
            query: query(snapshot),
            urlState: { v: 1, experience: 'recipe-console', view: 'tune' },
        });
        const model = deriveRecipeConsoleHistoryWindow(collection, 80);

        expect(model.rows.find(row =>
            row.distributedRunId === visibleDuplicate.distributedRunId
        )).toMatchObject({
            key: 'history-row:80',
            quarantined: true,
            quarantineCodes: ['ambiguous-run'],
            actions: { eligible: false, reason: 'quarantined' },
        });
        expect(model.rows.find(row =>
            row.distributedRunId === visibleAmbiguous.distributedRunId
        )).toMatchObject({
            key: 'history-row:81',
            pairStatus: 'ambiguous',
            controlStatus: 'ambiguous',
            quarantined: false,
            actions: { eligible: false, reason: 'ambiguous-control' },
        });
    });

    it('uses normalized committed filters and source-only context in its fingerprint', () => {
        const fixture = createRecipeConsoleControlScaleFixture({ pairCount: 4 });
        const first = createRecipeConsoleHistoryCollection({
            query: query(fixture.snapshot),
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                historyQuery: '  SCALE  ',
                historyGroup: ' RECIPE-CONSOLE-SCALE ',
                compareLeft: fixture.needles.distributedRunIds.first,
            },
        });
        const equivalent = createRecipeConsoleHistoryCollection({
            query: query(structuredClone(fixture.snapshot)),
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                historyQuery: 'scale',
                historyGroup: 'recipe-console-scale',
                compareRight: fixture.needles.distributedRunIds.last,
            },
        });
        const fallback = createRecipeConsoleHistoryCollection({
            query: query(fixture.snapshot, 'canonical-fallback'),
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                historyQuery: 'scale',
                historyGroup: 'recipe-console-scale',
            },
        });

        expect(first.fingerprint).toBe(equivalent.fingerprint);
        expect(fallback.fingerprint).not.toBe(first.fingerprint);
        expect(JSON.parse(first.fingerprint)).toEqual([
            'history-window-v1',
            'root-snapshot',
            'scale',
            'recipe-console-scale',
            null,
            null,
            null,
            null,
            null,
            null,
        ]);
    });
});
