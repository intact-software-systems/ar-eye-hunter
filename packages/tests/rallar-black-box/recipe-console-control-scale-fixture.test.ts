import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseControlRetentionPreview } from '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts';
import { validateDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    createRecipeConsoleControlScaleFixture,
    RECIPE_CONSOLE_CONTROL_SCALE_DEFAULT_PAIR_COUNT,
    type RecipeConsoleControlScaleFixture
} from '../../../packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts';

describe('Recipe Console control scale fixture', () => {
    it('keeps the public builder and its focused retention helper bounded', () => {
        for (
            const [fileName, budget] of [
                // Re-baselined after the dprint reformat: this file grew 275 -> 286 lines on
                // formatting alone, with no change to what it does.
                ['recipe-console-control-scale-fixture.ts', 300],
                ['recipe-console-control-scale-retention.ts', 140]
            ] as const
        ) {
            const source = readFileSync(
                new URL(
                    `../../../packages/shared-test/rallar-bb-test/${fileName}`,
                    import.meta.url
                ),
                'utf8'
            );
            expect(source.trimEnd().split(/\r?\n/u).length, fileName)
                .toBeLessThanOrEqual(budget);
        }
    });

    it('creates 5,000 deterministic ordered pairs with unique scale needles', () => {
        const fixture = createRecipeConsoleControlScaleFixture();
        const second = createRecipeConsoleControlScaleFixture();

        expect(RECIPE_CONSOLE_CONTROL_SCALE_DEFAULT_PAIR_COUNT).toBe(5_000);
        expect(fixture.counts).toEqual({
            pairs: 5_000,
            agents: 5_000,
            retentionCandidates: 0,
            retentionDistributedRuns: 0,
            retentionFleetReports: 0
        });
        expect(fixture.snapshot.runs).toHaveLength(5_000);
        expect(fixture.snapshot.distributedRuns).toHaveLength(5_000);
        expect(second).toEqual(fixture);
        expect(second).not.toBe(fixture);
        expect(second.snapshot).not.toBe(fixture.snapshot);

        const controlIds = fixture.snapshot.runs.map((run) => run.runId);
        const distributedIds = fixture.snapshot.distributedRuns?.map(
            (run) => run.distributedRunId
        ) ?? [];
        const agentIds = fixture.snapshot.runs.map((run) => run.agents[0]?.agentId);
        for (const position of ['first', 'middle', 'last', 'longBidi'] as const) {
            const index = fixture.positions[position];
            expect(controlIds[index]).toBe(fixture.needles.controlRunIds[position]);
            expect(distributedIds[index]).toBe(
                fixture.needles.distributedRunIds[position]
            );
            expect(agentIds[index]).toBe(fixture.needles.agentIds[position]);
            expect(controlIds.filter((id) => id === fixture.needles.controlRunIds[position])).toHaveLength(1);
            expect(distributedIds.filter((id) => id === fixture.needles.distributedRunIds[position])).toHaveLength(1);
        }
        expect(fixture.needles.controlRunIds.longBidi).toMatch(/[界\u202e\u2066]/u);
        expect(fixture.needles.controlRunIds.longBidi.length).toBeGreaterThan(120);

        for (let index = 0; index < fixture.counts.pairs; index += 1) {
            const control = fixture.snapshot.runs[index]!;
            const distributed = fixture.snapshot.distributedRuns?.[index]!;
            expect(distributed.controlRunId).toBe(control.runId);
            expect(distributed.manifest.controlRunId).toBe(control.runId);
            expect(distributed.manifest.distributedRunId).toBe(
                distributed.distributedRunId
            );
            expect(control.updatedAtEpochMs).toBe(distributed.updatedAtEpochMs);
            expect(validateDistributedRunManifest(distributed.manifest).ok).toBe(true);
        }
    });

    it('configures agents and exact token-free retention consequences independently', () => {
        const fixture = createRecipeConsoleControlScaleFixture({
            pairCount: 12,
            agentsPerRun: 3,
            retention: {
                candidateCount: 5,
                distributedRunsPerCandidate: 4,
                fleetReportsPerCandidate: 2
            }
        });

        expect(fixture.counts).toEqual({
            pairs: 12,
            agents: 36,
            retentionCandidates: 5,
            retentionDistributedRuns: 20,
            retentionFleetReports: 10
        });
        expect(fixture.snapshot.runs.every((run) => run.agents.length === 3)).toBe(true);
        expect(fixture.snapshot.runs.flatMap((run) => run.agents)).toHaveLength(36);
        expect(fixture.retention.candidates).toHaveLength(5);
        expect(fixture.retention.wouldDeleteRunIds).toEqual(
            fixture.retention.candidates.map((candidate) => candidate.runId)
        );
        expect(fixture.retention.candidates.every((candidate) =>
            candidate.distributedRuns.length === 4 &&
            candidate.fleetReportIds.length === 2
        )).toBe(true);
        expect(fixture.retention.wouldDeleteDistributedRunIds).toEqual(
            fixture.retention.candidates.flatMap((candidate) => candidate.distributedRuns.map((run) => run.distributedRunId))
        );
        expect(fixture.retention.wouldDeleteFleetReportIds).toEqual(
            fixture.retention.candidates.flatMap((candidate) => candidate.fleetReportIds)
        );
        expect(new Set(fixture.retention.wouldDeleteDistributedRunIds).size)
            .toBe(20);
        expect(new Set(fixture.retention.wouldDeleteFleetReportIds).size)
            .toBe(10);
        expect(JSON.stringify(fixture.retention)).not.toMatch(
            /planToken|authorization|credential|secret/i
        );
    });

    it('rejects consequences that cannot fit a valid preview envelope', () => {
        expect(() =>
            createRecipeConsoleControlScaleFixture({
                pairCount: 1_000,
                retention: {
                    candidateCount: 1_000,
                    distributedRunsPerCandidate: 60,
                    fleetReportsPerCandidate: 0
                }
            })
        ).toThrow(/canonicalNodes.*100000/i);
    });

    it.each(
        [
            ['candidate window', 205, 205, 1, 1],
            ['linked-item window', 4, 1, 201, 0]
        ] as const
    )(
        'keeps a valid high-pressure %s preview',
        (_label, pairCount, candidateCount, linkedCount, fleetCount) => {
            const fixture = createRecipeConsoleControlScaleFixture({
                pairCount,
                retention: {
                    candidateCount,
                    distributedRunsPerCandidate: linkedCount,
                    fleetReportsPerCandidate: fleetCount
                }
            });
            const preview = parseControlRetentionPreview(previewValue(fixture));

            expect(preview.wouldDeleteRuns).toHaveLength(candidateCount);
            expect(preview.wouldDeleteDistributedRunIds)
                .toHaveLength(candidateCount * linkedCount);
            expect(
                preview.wouldDeleteRuns.length >= 205 ||
                    preview.wouldDeleteDistributedRunIds.length >= 201
            ).toBe(true);
        }
    );
});

function previewValue(
    fixture: RecipeConsoleControlScaleFixture
): Record<string, unknown> {
    const candidateCount = fixture.retention.candidates.length;
    return {
        deletedRunIds: [],
        retainedRuns: candidateCount + 1,
        maxRuns: 1,
        dryRun: true,
        wouldDeleteRuns: fixture.retention.candidates,
        wouldDeleteRunIds: fixture.retention.wouldDeleteRunIds,
        wouldDeleteDistributedRunIds: fixture.retention.wouldDeleteDistributedRunIds,
        wouldDeleteFleetReportIds: fixture.retention.wouldDeleteFleetReportIds,
        projectedRetainedRuns: 1,
        preserves: {
            connectedAgentSockets: true,
            storedArtifactFiles: true
        },
        planToken: 'scale-fixture-plan-token'
    };
}
