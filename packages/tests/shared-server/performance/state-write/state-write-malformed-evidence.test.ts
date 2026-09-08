import {
    describe,
    expect,
    it
} from 'vitest';
import { compareNumber } from '../../../../../scripts/perf/api-v1-state-write-artifact-validation.mjs';
import {
    compareStateWriteArtifacts,
    validateStateWriteArtifact
} from '../../../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import { deriveAttempts } from '../../../../../scripts/perf/validate-state-write-attempt-evidence.mjs';
import { deriveFinalDurableCorrectness } from '../../../../../scripts/perf/validate-state-write-durable-evidence.mjs';
import {
    createDefaultStateWritePerformanceArtifact,
    type StateWritePerformanceSample
} from './test-support/state-write-performance-artifact-fixture.ts';

describe('state-write malformed evidence rejection', () => {
    it('retains the rejected exhausted-attempt source path without deriving its history', () => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        const sample = artifact.workloads[0].samples[0];
        const observation = sample.attemptObservations[0];
        Reflect.set(observation, 'outcome', 'exhausted');
        observation.terminal = true;
        Reflect.set(observation, 'source', 123);
        const errors: string[] = [];
        expect(() =>
            deriveAttempts({
                observations: sample.attemptObservations,
                commandsById: new Map(sample.commands.map((command) => [command.commandId, command])),
                appInboxEvidence: sample.durableEvidence.appInbox,
                path: 'sample',
                errors
            })
        ).not.toThrow();
        expect(errors).toContainEqual(expect.stringContaining('sample.attemptObservations[0].source'));
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('workloads[0].samples[0].attemptObservations[0].source')
        );
    });

    it.each(['receiptIds', 'outboxIds', 'resultBindings'])(
        'rejects scalar receipt %s before receipt linking',
        (field) => {
            const artifact = createDefaultStateWritePerformanceArtifact();
            const sample = artifact.workloads[0].samples[0];
            Reflect.set(sample.durableEvidence.receipts[0], field, 123);
            const errors: string[] = [];
            expect(() =>
                deriveFinalDurableCorrectness({
                    sample,
                    commandsById: new Map(sample.commands.map((command) => [command.commandId, command])),
                    path: 'sample',
                    errors
                })
            ).not.toThrow();
            expect(errors).toContainEqual(expect.stringContaining('sample.durableEvidence.receipts[0]'));
            const baseline = createDefaultStateWritePerformanceArtifact();
            expect(compareStateWriteArtifacts(baseline, artifact)).toContainEqual(
                expect.stringContaining('candidate: workloads[0].samples[0].durableEvidence.receipts[0]')
            );
            expect(compareStateWriteArtifacts(artifact, baseline)).toContainEqual(
                expect.stringContaining('baseline: workloads[0].samples[0].durableEvidence.receipts[0]')
            );
        }
    );

    it('rejects a malformed persisted command type before embedded receipt inspection', () => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        const sample = artifact.workloads[0].samples[0];
        Reflect.set(sample.durableEvidence.appInbox[0], 'commandType', 123);
        const errors: string[] = [];
        expect(() =>
            deriveFinalDurableCorrectness({
                sample,
                commandsById: new Map(sample.commands.map((command) => [command.commandId, command])),
                path: 'sample',
                errors
            })
        ).not.toThrow();
        expect(errors).toContainEqual(expect.stringContaining('sample.durableEvidence.appInbox[0]'));
    });

    it('retains the raw command kind rejection instead of passing it into durable derivation', () => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        Reflect.set(artifact.workloads[0].samples[0].commands[0], 'kind', 123);
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('workloads[0].samples[0].commands[0].kind')
        );
    });

    it.each([{ value: 123 }, { value: [{ toString: 0 }, { toString: 0 }] }])(
        'retains the malformed summary findings path before comparing findings (%j)',
        ({ value }) => {
            const artifact = createDefaultStateWritePerformanceArtifact();
            Reflect.set(artifact.workloads[0].summary.correctness, 'dbwFindings', value);
            expect(validateStateWriteArtifact(artifact)).toContainEqual(
                expect.stringContaining('workloads[0].summary.correctness.dbwFindings')
            );
        }
    );

    it.each(['operationId', 'commandHash'])('rejects non-string binding %s without coercion', (field) => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        Reflect.set(artifact.workloads[0].samples[0].durableEvidence.receipts[0].resultBindings[0], field, { toString: 0 });
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('workloads[0].samples[0].durableEvidence.receipts[0]')
        );
    });

    it('describes an invalid metric by type without invoking raw value coercion', () => {
        const errors: string[] = [];
        expect(() =>
            compareNumber({
                actual: { toString: 0 },
                expected: 1,
                path: 'sample.correctness.receiptCount',
                errors,
                source: 'durable records'
            })
        ).not.toThrow();
        expect(errors).toContainEqual(expect.stringContaining('sample.correctness.receiptCount'));
        const artifact = createDefaultStateWritePerformanceArtifact();
        Reflect.set(artifact.workloads[0].samples[0].correctness, 'receiptCount', { toString: 0 });
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('workloads[0].samples[0].correctness.receiptCount')
        );
    });

    it.each(
        [
            ['durationMs', (sample: StateWritePerformanceSample) => Reflect.set(sample, 'durationMs', { toString: 0 })],
            [
                'correctness.dbwFindings[0]',
                (sample: StateWritePerformanceSample) => Reflect.set(sample.correctness, 'dbwFindings', [{ toString: 0 }, { toString: 0 }])
            ],
            ['sql.statements', (sample: StateWritePerformanceSample) => Reflect.set(sample.sql, 'statements', { toString: 0 })],
            ['postgres.cpuTimeMs', (sample: StateWritePerformanceSample) => Reflect.set(sample.postgres, 'cpuTimeMs', { toString: 0 })],
            ['timingsMs.read', (sample: StateWritePerformanceSample) => Reflect.set(sample.timingsMs, 'read', { toString: 0 })],
            [
                'durableEvidence.atomicCompletionFailures',
                (sample: StateWritePerformanceSample) => Reflect.set(sample.durableEvidence, 'atomicCompletionFailures', { toString: 0 })
            ],
            [
                'durableEvidence.receipts[0]',
                (sample: StateWritePerformanceSample) => Reflect.set(sample.durableEvidence.receipts[0], 'outboxIds', { length: { toString: 0 } })
            ]
        ] as const
    )('preserves %s rejection through summary and both comparison roles', (path, mutate) => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        mutate(artifact.workloads[0].samples[0]);
        const parsed: unknown = JSON.parse(JSON.stringify(artifact));
        const baseline = createDefaultStateWritePerformanceArtifact();
        const expectedPath = `workloads[0].samples[0].${path}`;

        const validation = validateStateWriteArtifact(parsed);
        const candidateComparison = compareStateWriteArtifacts(baseline, parsed);
        const baselineComparison = compareStateWriteArtifacts(parsed, baseline);

        expect(validation).toContainEqual(expect.stringContaining(expectedPath));
        expect(candidateComparison).toContainEqual(expect.stringContaining(`candidate: ${expectedPath}`));
        expect(baselineComparison).toContainEqual(expect.stringContaining(`baseline: ${expectedPath}`));
        for (const errors of [validation, candidateComparison, baselineComparison]) {
            expect(errors).not.toContainEqual(expect.stringContaining('could not be derived safely'));
        }
    });

    it.each(['sql', 'postgres', 'timingsMs'] as const)('derives only declared %s metrics and ignores extra opaque data', (container) => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        for (const sample of artifact.workloads[0].samples) {
            Reflect.set(sample[container], 'extra', { toString: 0 });
        }
        const parsed: unknown = JSON.parse(JSON.stringify(artifact));
        expect(validateStateWriteArtifact(parsed)).toEqual([]);
        expect(compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), parsed)).toEqual([]);
    });

    it('preserves structurally safe sample, summary and comparative correctness mismatches', () => {
        const artifact = createDefaultStateWritePerformanceArtifact();
        const workload = artifact.workloads[0];
        workload.samples[0].correctness.dbwFindings = ['DBW-AGGREGATE-MISMATCH'];
        workload.samples[0].durableEvidence.atomicCompletionFailures = 1;
        workload.summary.sql.statements += 1;
        const errors = compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), artifact);
        expect(errors).toContainEqual(expect.stringContaining('candidate: workloads[0].samples[0].durableEvidence.atomicCompletionFailures does not match'));
        expect(errors).toContainEqual(expect.stringContaining('candidate: workloads[0].summary.correctness.dbwFindings does not match raw samples'));
        expect(errors).toContainEqual(expect.stringContaining('candidate: workloads[0].summary.sql.statements does not match sample median'));
        expect(errors).toContainEqual(expect.stringContaining('uncontended candidate correctness failed: atomic completion failures (1) != 0'));
    });
});
