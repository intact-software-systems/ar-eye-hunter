import { describe, expect, it } from 'vitest';

import {
    GROUP_TOPOLOGY_CONFLICT_REASON,
    GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
    parseGroupTopologyRegressionReasons
} from '../../../../../scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs';

import { parseBenchmarkOptions } from '../../../../../scripts/perf/state-write/api-v1-state-write-benchmark-options.ts';

import { selectStateWriteRegressionReasons } from '../../../../../scripts/perf/state-write/api-v1-state-write-regression-reasons.ts';

import type { StateWriteBenchmarkRegressionReason } from '../../../../../scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts';

const APPROVED_PR_C_BASE_COMMIT = '39ad65b499c4bf944acfe48446ad1c334d97d37d';
const CANDIDATE_COMMIT = '74a62eb22583216e8c6651de069209d7e1a8ca67';
const CANDIDATE_TREE = '7f971bcf84aa494265992d17e3c9b99227bd8122';
const CANDIDATE_IDENTITY = { commit: CANDIDATE_COMMIT, tree: CANDIDATE_TREE } as const;

describe('API-v1 state-write topology regression reasons', { timeout: 30_000 }, () => {
    it('binds precommitted topology conflict reasons before measurement', async () => {
        const artifactOwner = await import('../../../../../scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts');
        const input = createConflictReasonInput();
        const parseReasons = (text: string | undefined) => parseGroupTopologyRegressionReasons(text, CANDIDATE_IDENTITY);
        expect(parseReasons(undefined)).toEqual([]);
        expect(parseReasons(JSON.stringify(input))).toEqual(input.reasons);
        expect(
            parseBenchmarkOptions(['--regression-reasons-file=tmp/perf/topology-reasons.json'])
        ).toMatchObject({ regressionReasonsFile: 'tmp/perf/topology-reasons.json' });
        const createArtifact = (regressionReasons: readonly StateWriteBenchmarkRegressionReason[]) =>
            artifactOwner.createStateWriteBenchmarkArtifact({
                generatedAt: '2026-08-09T00:00:00.000Z',
                gitIdentity: CANDIDATE_IDENTITY,
                options: parseBenchmarkOptions([]),
                regressionReasons,
                workloads: [{ name: 'sentinel-workload' }]
            });
        expect(createArtifact(parseReasons(JSON.stringify(input))).regressionReasons).toEqual(
            input.reasons
        );
        expect(createArtifact([])).toMatchObject({ regressionReasons: [] });
        expect(createArtifact([])).not.toHaveProperty('features');
        const artifactBytes = new TextEncoder().encode(
            `${
                JSON.stringify(
                    createArtifact([
                        { workload: 'shared', metric: 'sql.statements', reason: 'precommitted reason' }
                    ]),
                    null,
                    2
                )
            }\n`
        );
        const artifactDigest = await crypto.subtle.digest('SHA-256', artifactBytes);
        expect(toHex(artifactDigest)).toBe(
            '00830eb1e67353eb1749fa4d7865b507dec74f05fad2dac76a840c0a997b7fc8'
        );
        expect(() => parseBenchmarkOptions(['--regression-reasons-file=tmp/perf/../topology-reasons.json'])).toThrow(/must remain under tmp\/perf/);
        for (const mutate of conflictReasonFailures()) {
            const malformed = structuredClone(input);
            mutate(malformed);
            expect(() => parseReasons(JSON.stringify(malformed))).toThrow(/conflict reason/);
        }
    });

    it('selects RTC durable-append reasons without contaminating other captures', () => {
        const rtcOptions = parseBenchmarkOptions([
            '--regression-reason-profile=rtc-topology-durable-append'
        ]);
        expect(rtcOptions).toMatchObject({
            regressionReasonProfile: 'rtc-topology-durable-append'
        });
        expect(selectStateWriteRegressionReasons(rtcOptions.regressionReasonProfile, [])).toHaveLength(
            12
        );

        const ordinaryOptions = parseBenchmarkOptions([]);
        expect(selectStateWriteRegressionReasons(ordinaryOptions.regressionReasonProfile, [])).toEqual(
            []
        );

        const groupTopologyOptions = parseBenchmarkOptions([
            '--regression-reasons-file=tmp/perf/topology-reasons.json'
        ]);
        const groupTopologyReasons = createConflictReasonInput().reasons;
        expect(
            selectStateWriteRegressionReasons(
                groupTopologyOptions.regressionReasonProfile,
                groupTopologyReasons
            )
        ).toEqual(groupTopologyReasons);

        expect(() =>
            parseBenchmarkOptions([
                '--regression-reason-profile=rtc-topology-durable-append',
                '--regression-reasons-file=tmp/perf/topology-reasons.json'
            ])
        ).toThrow(/cannot be combined/);
        expect(() => parseBenchmarkOptions(['--regression-reason-profile=unapproved'])).toThrow(
            /Unsupported state-write regression reason profile/
        );
    });
});

function createConflictReasonInput(): any {
    const metrics = [
        'sql.statements',
        'sql.rowsRead',
        'sql.serializedResultBytes',
        'postgres.transactionDurationMs'
    ];
    return {
        schemaVersion: GROUP_TOPOLOGY_CONFLICT_REASON_SCHEMA,
        baseCommit: APPROVED_PR_C_BASE_COMMIT,
        candidateCommit: CANDIDATE_COMMIT,
        candidateTree: CANDIDATE_TREE,
        reasons: ['uncontended', 'shared', 'hot'].flatMap((workload) => metrics.map((metric) => ({ workload, metric, reason: GROUP_TOPOLOGY_CONFLICT_REASON })))
    };
}

function conflictReasonFailures(): readonly ((input: any) => void)[] {
    return [
        (input) => (input.extra = true),
        (input) => (input.baseCommit = CANDIDATE_COMMIT),
        (input) => (input.candidateCommit = APPROVED_PR_C_BASE_COMMIT),
        (input) => (input.candidateTree = APPROVED_PR_C_BASE_COMMIT),
        (input) => input.reasons.pop(),
        (input) => (input.reasons[0].metric = 'sql.unsupported'),
        (input) => (input.reasons[0].reason = 'written after measurement'),
        (input) => ([input.reasons[0], input.reasons[1]] = [input.reasons[1], input.reasons[0]])
    ];
}

function toHex(value: ArrayBuffer): string {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
