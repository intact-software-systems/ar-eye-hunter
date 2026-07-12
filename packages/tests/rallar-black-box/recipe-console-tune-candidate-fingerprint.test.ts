import { describe, expect, it } from 'vitest';
import type { DistributedArtifactWorkspaceSupport } from
    '../../../packages/shared-test/rallar-bb-test/distributed-artifact-workspace-contracts.ts';
import { tuneCandidateFingerprint } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-candidate-fingerprint.ts';
import type { TuneSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-model.ts';

type FingerprintSourceFixture = {
    provenance: {
        source: 'artifact' | 'control' | 'none';
        detail: 'detailed' | 'inspectable' | 'bounded' | 'unavailable';
        generatedAtEpochMs?: number;
        limitations: string[];
    };
    retained: {
        relation: 'none' | 'matching' | 'mismatched' | 'context-error';
        support?: DistributedArtifactWorkspaceSupport;
    };
    distributedRun: {
        distributedRunId: string;
        controlRunId: string;
        createdAtEpochMs: number;
        updatedAtEpochMs: number;
        startedAtEpochMs: number;
        completedAtEpochMs: number;
    };
    controlRun: {
        runId: string;
        createdAtEpochMs: number;
        updatedAtEpochMs: number;
    };
    identity: {
        distributedRunId: string;
        controlRunId: string;
        quarantined: boolean;
        issues: string[];
    };
    inventory: {
        knobs: Array<{
            name: 'rateHz';
            pointer: string;
            scope: 'command';
            currentValue?: number;
            availability: 'configured' | 'unset' | 'blocked';
            effective: boolean;
            constraint: { type: 'number'; exclusiveMinimum: number };
        }>;
        limitations: [];
    };
    candidate: { allowed: boolean; reasons: string[] };
    issues: [];
};

function fixture(): FingerprintSourceFixture {
    return {
        provenance: {
            source: 'artifact', detail: 'detailed',
            generatedAtEpochMs: 10_000, limitations: [],
        },
        retained: { relation: 'matching', support: 'supported' },
        distributedRun: {
            distributedRunId: 'distributed-a', controlRunId: 'control-a',
            createdAtEpochMs: 1_000, updatedAtEpochMs: 2_000,
            startedAtEpochMs: 1_100, completedAtEpochMs: 1_900,
        },
        controlRun: {
            runId: 'control-a', createdAtEpochMs: 900, updatedAtEpochMs: 2_100,
        },
        identity: {
            distributedRunId: 'distributed-a', controlRunId: 'control-a',
            quarantined: false, issues: [],
        },
        inventory: {
            knobs: [{
                name: 'rateHz', pointer: '/recipes/0/recipe/commands/0/rateHz',
                scope: 'command', currentValue: 20,
                availability: 'configured', effective: true,
                constraint: { type: 'number', exclusiveMinimum: 0 },
            }],
            limitations: [],
        },
        candidate: { allowed: true, reasons: [] },
        issues: [],
    };
}

function fingerprint(
    mutate: (source: FingerprintSourceFixture) => void = () => undefined,
): string {
    const source = structuredClone(fixture());
    mutate(source);
    return tuneCandidateFingerprint(source as unknown as TuneSourceModel);
}

describe('Recipe Console Tune candidate fingerprint', () => {
    it('ignores routine snapshot freshness when deterministic candidate truth is unchanged', () => {
        const baseline = fingerprint();
        const refreshed = fingerprint(source => {
            source.provenance.generatedAtEpochMs = 90_000;
            source.distributedRun.createdAtEpochMs = 81_000;
            source.distributedRun.updatedAtEpochMs = 82_000;
            source.distributedRun.startedAtEpochMs = 81_100;
            source.distributedRun.completedAtEpochMs = 81_900;
            source.controlRun.createdAtEpochMs = 80_900;
            source.controlRun.updatedAtEpochMs = 82_100;
        });

        expect(refreshed).toBe(baseline);
    });

    it('resets for every identity, support, and deterministic knob-truth change', () => {
        const baseline = fingerprint();
        const resetVariants = [
            fingerprint(source => { source.inventory.knobs[0].currentValue = 25; }),
            fingerprint(source => { source.inventory.knobs[0].availability = 'blocked'; }),
            fingerprint(source => { source.inventory.knobs[0].effective = false; }),
            fingerprint(source => { source.inventory.knobs[0].pointer += '-other'; }),
            fingerprint(source => { source.identity.distributedRunId = 'distributed-b'; }),
            fingerprint(source => { source.identity.controlRunId = 'control-b'; }),
            fingerprint(source => { source.identity.quarantined = true; }),
            fingerprint(source => { source.distributedRun.distributedRunId = 'distributed-b'; }),
            fingerprint(source => { source.distributedRun.controlRunId = 'control-b'; }),
            fingerprint(source => { source.controlRun.runId = 'control-b'; }),
            fingerprint(source => { source.provenance.source = 'control'; }),
            fingerprint(source => { source.provenance.detail = 'inspectable'; }),
            fingerprint(source => { source.retained.relation = 'mismatched'; }),
        ];
        const supportFingerprints = (
            ['supported', 'incomplete', 'incompatible', 'unsupported'] as const
        ).map(support => fingerprint(source => {
            source.retained.support = support;
            source.provenance.detail = support === 'supported'
                ? 'detailed'
                : 'inspectable';
        }));

        for (const changed of resetVariants) expect(changed).not.toBe(baseline);
        expect(new Set(supportFingerprints)).toHaveLength(4);
    });
});
