import { execFileSync } from 'node:child_process';
import {
    mkdtempSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    artifactEventsWithTruncation,
    selectArtifactEvents,
    withArtifactReport
} from '../../shared-test/black-box-runner/artifacts/scenario-run-artifacts.ts';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { executeAssertInteraction } from '../../shared-test/black-box-runner/execution/execute-assert-interaction.ts';
import { validateAssertValueComparators } from '../../shared-test/black-box-runner/expectations/assert-value-comparators.ts';
import { toExecutableInteractions } from '../../shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import { computeScenarioMetrics } from '../../shared-test/black-box-runner/reports/scenario-metrics.ts';
import { toPostRunAssertionResult } from '../../shared-test/black-box-runner/reports/scenario-post-run-assertions.ts';

const opaque: unknown = JSON.parse('{"toString":0}');

describe('scenario assertion boundaries', () => {
    it('compares opaque JSON without unrelated numeric conversion', () => {
        expect(validateAssertValueComparators({ payload: opaque }, [
            { path: 'payload', equals: opaque },
            { path: 'payload', notEquals: { other: true } }
        ])).toEqual([]);
    });

    it('collects every malformed comparator as an issue', () => {
        const issues = validateAssertValueComparators({ count: 2, text: 'abc', payload: opaque }, [
            { path: 'count', gte: opaque },
            { path: 'payload', between: [0, 4] },
            { path: 'text', length: opaque },
            { path: 'text', contains: opaque },
            { path: 'text', matches: '[' },
            { path: 'count', lte: 1 }
        ]);
        expect(issues.map(({ path, comparator }) => ({ path, comparator }))).toEqual([
            { path: 'count', comparator: 'gte' },
            { path: 'payload', comparator: 'between' },
            { path: 'text', comparator: 'length' },
            { path: 'text', comparator: 'contains' },
            { path: 'text', comparator: 'matches' },
            { path: 'count', comparator: 'lte' }
        ]);
    });

    it('preserves numeric-string, range, length, text and existence behavior', () => {
        expect(validateAssertValueComparators({ count: '3', text: 'abc', payload: opaque }, [
            { path: 'count', gt: '2', gte: 3, lt: '4', lte: 3, between: ['2', 4] },
            { path: 'text', length: '3', contains: 'b', matches: '^a' },
            { path: 'payload', exists: true },
            { path: 'absent', exists: false }
        ])).toEqual([]);
    });

    it('rejects a malformed existence operand instead of treating it as true', () => {
        expect(validateAssertValueComparators({ value: 1 }, [{ path: 'value', exists: opaque }]))
            .toMatchObject([{ path: 'value', comparator: 'exists' }]);
        expect(toPostRunAssertionResult({ path: 'value', exists: opaque }, 0, { value: 1 }).status)
            .toBe('FAILURE');
    });

    it.each([opaque, 'unsupported', false, 0, null, ''])('reports malformed comparison configuration as failed evidence', async (comparison) => {
        const interaction = { request: { actual: { value: 1 } }, response: { body: { value: 1 }, comparison } };
        const result = await executeAssertInteraction(interaction, { interactionName: 'config', interaction }, {});
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Assert comparison failed');
        expect(toPostRunAssertionResult({ path: 'value', equals: 1, comparison }, 0, { value: 1 }).status)
            .toBe('FAILURE');
    });

    it.each(['ignoreJsonKeys', 'ignoreJsonPaths'])('rejects supplied malformed %s controls', async (field) => {
        for (const value of [opaque, [false], false, 0, null, '']) {
            const interaction = { request: { actual: 1 }, response: { body: 1, [field]: value } };
            const result = await executeAssertInteraction(interaction, { interactionName: 'control', interaction }, {});
            expect(result.status).toBe('FAILURE');
            expect(result.result).toBe('Assert comparison failed');
            expect(toPostRunAssertionResult({ actual: 1, equals: 1, [field]: value }, 0, {}).status).toBe('FAILURE');
            expect(toPostRunAssertionResult({ actual: 1, notEquals: 2, [field]: value }, 0, {}).status).toBe('FAILURE');
        }
    });

    it.each(['comparators', 'monotonicPaths', 'anyOf'])('rejects malformed %s collections despite a matching body', async (field) => {
        const interaction = { request: { actual: 1 }, response: { body: 1, [field]: opaque } };
        const result = await executeAssertInteraction(interaction, { interactionName: 'collection', interaction }, {});
        expect(result.status).toBe('FAILURE');
        if (field === 'comparators') {
            expect(result.result).toBe('Assert comparator failed');
            expect(validateAssertValueComparators(1, opaque)).toHaveLength(1);
        }
        if (field === 'monotonicPaths') {
            expect(result.result).toBe('Assert monotonic comparison failed');
        }
    });

    it('preserves omitted controls, empty lists and valid ignored-key semantics', async () => {
        for (const controls of [{}, { comparators: [], monotonicPaths: [], anyOf: [] }]) {
            const interaction = { request: { actual: opaque }, response: { body: opaque, ...controls } };
            expect((await executeAssertInteraction(interaction, { interactionName: 'default', interaction }, {})).status).toBe('SUCCESS');
        }
        const interaction = {
            request: { actual: { value: 1, stamp: 2 } },
            response: { body: { value: 1, stamp: 1 }, ignoreJsonKeys: ['stamp'], ignoreJsonPaths: [] }
        };
        expect((await executeAssertInteraction(interaction, { interactionName: 'ignore', interaction }, {})).status).toBe('SUCCESS');
        expect(toPostRunAssertionResult({ actual: { value: 1, stamp: 2 }, equals: { value: 1, stamp: 1 }, ignoreJsonKeys: ['stamp'] }, 0, {}).status).toBe(
            'SUCCESS'
        );
        expect(validateAssertValueComparators(1, undefined)).toEqual([]);
    });

    it('rejects malformed comparison after actual recipe compilation and execution', async () => {
        const compiled = toExecutableInteractions({ steps: [{ name: 'invalid-mode', type: 'assert', actual: 1, expect: { body: 1, comparison: false } }] });
        const report = await executeBlackBox(compiled, 0, { dependencies: { now: () => 10, createUuid: () => 'compiled-control-run' } });
        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName['invalid-mode']).toMatchObject([{ result: 'Assert comparison failed', status: 'FAILURE' }]);
    });

    it('rejects invalid object-membership operands and extra range members', () => {
        expect(toPostRunAssertionResult({ actual: { a: 1 }, notIncludes: opaque }, 0, {}).status).toBe('FAILURE');
        expect(toPostRunAssertionResult({ actual: 1, notIncludes: 2 }, 0, {}).status).toBe('FAILURE');
        expect(toPostRunAssertionResult({ actual: 1, between: [0, 2, opaque] }, 0, {}).status).toBe('FAILURE');
        expect(toPostRunAssertionResult({ actual: [opaque], includes: opaque }, 0, {}).status).toBe('SUCCESS');
        expect(toPostRunAssertionResult({ actual: { a: 1 }, includes: 'a' }, 0, {}).status).toBe('SUCCESS');
        expect(toPostRunAssertionResult({ actual: { a: 1 }, notIncludes: 'b' }, 0, {}).status).toBe('SUCCESS');
    });

    it('returns the precise monotonic failure for malformed numeric evidence', async () => {
        const interaction = {
            request: { actual: { history: [1, opaque] } },
            response: { body: {}, monotonicPaths: ['history'] }
        };
        const result = await executeAssertInteraction(interaction, { interactionName: 'history', interaction }, {});
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Assert monotonic comparison failed');
        expect(result.details).toMatchObject({
            failures: [
                { path: 'history', values: [1, opaque], error: 'Monotonic assertion values must be finite numbers.' }
            ]
        });
    });

    it('preserves monotonic numeric-string success and real regression failure', async () => {
        for (const [history, expectedStatus] of [[['1', '2', '2'], 'SUCCESS'], [[1, 3, 2], 'FAILURE']] as const) {
            const interaction = {
                request: { actual: { history } },
                response: { body: { history }, monotonicPaths: ['history'] }
            };
            const result = await executeAssertInteraction(interaction, { interactionName: 'history', interaction }, {});
            expect(result.status).toBe(expectedStatus);
        }
    });

    it.each(['gte', 'between', 'contains'])('returns a failed post-run %s result for malformed operands', (operator) => {
        const spec = { path: 'value', [operator]: operator === 'between' ? [0, opaque] : opaque };
        const result = toPostRunAssertionResult(spec, 0, { value: operator === 'contains' ? 'abc' : 2 });
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Post-run assertion failed');
        expect(result.path).toBe('value');
        expect(result.operator).toBe(operator);
    });

    it.each(['operator', 'op'])('does not reinterpret a malformed %s as equality', (field) => {
        const result = toPostRunAssertionResult({ path: 'value', expected: 1, [field]: opaque }, 0, { value: 1 });
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Post-run assertion failed');
        expect(result.details).toMatchObject({ reason: 'invalid-post-run-operator' });
    });

    it('keeps opaque post-run equality and numeric-string thresholds valid', () => {
        expect(toPostRunAssertionResult({ path: 'value', equals: opaque }, 0, { value: opaque }).status)
            .toBe('SUCCESS');
        expect(toPostRunAssertionResult({ path: 'value', between: ['2', '4'] }, 0, { value: '3' }).status)
            .toBe('SUCCESS');
        expect(toPostRunAssertionResult({ actual: '5', between: ['2', '4'] }, 0, {}).details)
            .toMatchObject({ reason: 'between-threshold-not-met', min: '2', max: '4' });
    });
});

describe('scenario report boundaries', () => {
    it('counts property-name categories as ordinary report keys', () => {
        const report = {
            resultsList: [{ status: 'constructor', transport: '__proto__' }],
            rtcDiagnostics: { peer: [{ severity: 'constructor', topic: '__proto__' }] }
        };
        const metrics = computeScenarioMetrics(report);
        expect(Object.entries(metrics.byStatus)).toEqual([['constructor', 1]]);
        expect(Object.entries(metrics.byTransport)).toEqual([['__proto__', 1]]);
        expect(metrics.diagnostics.bySeverity.constructor).toBe(1);
        expect(Object.entries(metrics.diagnostics.byTopic)).toEqual([['__proto__', 1]]);
        const counts = selectArtifactEvents(report, 1).index.counts.total;
        expect(Object.entries(counts.byStatus)).toContainEqual(['constructor', 1]);
        expect(Object.entries(counts.byTransport)).toContainEqual(['__proto__', 1]);
    });

    it('ignores invalid latency observations and narrows diagnostic categories', () => {
        const metrics = computeScenarioMetrics({
            resultsList: [
                { status: 'SUCCESS', action: 'send', actual: { sendLatencyMs: '4' }, durationMs: '6' },
                { status: 'SUCCESS', action: opaque, transport: opaque, actual: { sendLatencyMs: opaque } }
            ],
            rtcDiagnostics: { peer: [{ severity: opaque, topic: opaque }, { severity: 'warn', topic: 'repair' }] }
        });
        expect(metrics.latencyMs.send).toEqual({ count: 1, min: 4, max: 4, avg: 4, p50: 4, p95: 4, p99: 4 });
        expect(metrics.latencyMs.stepDuration.count).toBe(1);
        expect(metrics.byAction).toEqual({ send: 1, unknown: 1 });
        expect(metrics.diagnostics).toEqual({
            total: 2,
            bySeverity: { debug: 0, info: 0, warning: 1, error: 0, unknown: 1 },
            byTopic: { unknown: 1, repair: 1 }
        });
    });

    it('ignores invalid caps and retains numeric-string caps, failures and opaque payloads', () => {
        const report = {
            resultsList: [
                { name: 'repeat', status: 'SUCCESS', actual: opaque },
                { name: 'repeat', status: 'SUCCESS', actual: { second: true } },
                { name: 'failed', status: 'FAILURE', actual: opaque }
            ],
            artifactLimits: { maxEvents: opaque, maxEventsByKind: { 'step-result': '1', 'rtc-message': opaque } }
        };
        const selection = selectArtifactEvents(report, 1234);
        expect(selection.index.generatedAtEpochMs).toBe(1234);
        expect(selection.emittedEvents.map((event) => event.status)).toEqual(['SUCCESS', 'FAILURE']);
        expect(selection.emittedEvents[0].actual).toEqual(opaque);
        expect(selection.index.truncation).toMatchObject({
            totalEvents: 3,
            emittedEvents: 2,
            omittedEvents: 1,
            maxEventsByKind: { 'step-result': 1 },
            preservedFailureEvents: 1
        });
        expect(artifactEventsWithTruncation(selection).at(-1)).toMatchObject({
            kind: 'artifact-truncated',
            omittedEvents: 1
        });
        expect(withArtifactReport(report, 1234).artifact).toMatchObject({
            eventCount: 3,
            emittedEvents: 2,
            omittedEvents: 1,
            compactedSuccessGroups: 1
        });
    });
});

describe('scenario result-name ownership', () => {
    it.each(['ordinary', 'constructor', '__proto__'])('stores a valid %s result name through actual execution', async (name) => {
        const report = await executeBlackBox(
            [{
                SET: { request: { output: 'value', value: 1, scenarioExecutionNumber: 1, interactionExecutionNumber: 1 }, response: {} },
                [name]: {}
            }],
            0,
            { dependencies: { now: () => 10, createUuid: () => 'result-name-run' } }
        );
        expect(report.summary.failure).toBe(0);
        expect(Object.hasOwn(report.resultsByName, name)).toBe(true);
        expect(report.resultsByName[name]).toMatchObject([{ name, status: 'SUCCESS' }]);
    });

    it('preserves repeated property-name results in the actual CLI scale report', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'scenario-result-names-'));
        try {
            writeFileSync(
                path.join(directory, 'config.json'),
                JSON.stringify({
                    execution: { iterations: 2 },
                    steps: ['constructor', '__proto__'].map((name) => ({ name, type: 'set', output: 'value', value: 1 }))
                })
            );
            const output = execFileSync('deno', [
                'run',
                '-A',
                fileURLToPath(new URL('../../shared-test/black-box-runner/scenario-black-box.ts', import.meta.url)),
                '-w',
                directory,
                '-c',
                'config.json'
            ], { encoding: 'utf8' });
            const report = JSON.parse(output);
            expect(report.summary).toMatchObject({ failure: 0, success: 4, runs: 2 });
            for (const name of ['constructor', '__proto__']) {
                expect(Object.hasOwn(report.resultsByName, name)).toBe(true);
                expect(report.resultsByName[name]).toMatchObject([{ name, runIndex: 1 }, { name, runIndex: 2 }]);
            }
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
