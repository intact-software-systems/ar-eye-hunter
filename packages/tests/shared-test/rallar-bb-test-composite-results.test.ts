import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonComparisonObject } from '../../shared-test/json-compare/compare-json-values.ts';
import {
    computeRallarBlackBoxCompositeResultSummary,
    createRallarBlackBoxTestRuntime,
    resolveRallarBlackBoxCompositeFirstFailure,
    toRallarBlackBoxCompositeDisplayResults,
    toRallarBlackBoxCompositeResultFlatEntries,
    toRallarBlackBoxCompositeResultTimeline,
    toRallarBlackBoxCompositeResultTree,
    type RallarBlackBoxCompositeResultSummary,
    type RallarBlackBoxCompositeResultTreeNode,
    type RallarBlackBoxTestParallelChildResult,
    type RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/mod.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

interface CompositeResultTreeShape {
    readonly path: string;
    readonly children: readonly CompositeResultTreeShape[];
}

/** A recorded parallel child whose result may lack the fields a command result requires. */
interface RecordedParallelChild {
    readonly commandId: string;
    readonly commandIndex: number;
    readonly result: RallarBlackBoxTestResult | Pick<RallarBlackBoxTestResult, 'commandId' | 'kind'>;
}

type RecordedParallelChildPosition = Omit<RallarBlackBoxTestParallelChildResult, keyof RecordedParallelChild>;

interface RecordedParallelChildWithPosition extends RecordedParallelChild, RecordedParallelChildPosition {}

interface CompositeResultFixture {
    readonly summary: RallarBlackBoxCompositeResultSummary;
    readonly paths: readonly string[];
    readonly sourceRecipePaths: readonly string[];
    readonly tree: readonly CompositeResultTreeShape[];
    readonly redactedFailure: JsonComparisonObject;
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturePath = path.join(
    repoRoot,
    'packages/tests/shared-test/fixtures/rallar-bb-test/composite-result-summary-v1.json'
);

function readFixture(): CompositeResultFixture {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    assertCompositeResultFixture(fixture);
    return fixture;
}

function assertCompositeResultFixture(value: unknown): asserts value is CompositeResultFixture {
    const hasSections = isJsonRecordValue(value) &&
        isJsonRecordValue(value.summary) &&
        Array.isArray(value.paths) &&
        Array.isArray(value.sourceRecipePaths) &&
        Array.isArray(value.tree) &&
        isJsonRecordValue(value.redactedFailure);
    if (!hasSections) {
        throw new Error('composite-result-summary-v1.json does not hold the composite result fixture sections.');
    }
}

function toTreeShape(nodes: readonly RallarBlackBoxCompositeResultTreeNode[]): readonly CompositeResultTreeShape[] {
    return nodes.map((node) => ({
        path: node.entry.path,
        children: toTreeShape(node.children)
    }));
}

function toLeafResult(commandId: string): RallarBlackBoxTestResult {
    return {
        commandId,
        kind: 'rtc.send',
        status: 'ok',
        ok: true,
        startedAtEpochMs: 1_000,
        endedAtEpochMs: 1_001,
        durationMs: 1
    };
}

function toParallelChild(child: RecordedParallelChild): RecordedParallelChildWithPosition {
    return {
        ...child,
        parentCommandId: 'parallel-partly-decodable',
        path: `$.groups[0=g].commands[${child.commandIndex}]`,
        sourceRecipePath: `$.groups[0].commands[${child.commandIndex}]`,
        childIndex: child.commandIndex,
        groupId: 'g',
        groupIndex: 0
    };
}

async function runNestedCompositeResult(): Promise<RallarBlackBoxTestResult> {
    let now = 1_000;
    const runtime = createRallarBlackBoxTestRuntime({
        now: () => now++,
        commandExecutor: (command, context) => {
            if (command.kind !== 'rtc.send') {
                return undefined;
            }

            const loop = command.metadata?.loop;
            if (isJsonRecordValue(loop) && loop.iteration === 2) {
                return {
                    status: 'failed',
                    error: {
                        code: 'SEND_FAILED',
                        message: 'Synthetic send failure.',
                        details: {
                            token: 'secret-token',
                            body: 'contains hidden-body'
                        }
                    },
                    nextStatus: 'failed'
                };
            }

            return {
                status: 'ok',
                value: {
                    sent: true,
                    password: 'secret-token',
                    metadata: command.metadata
                },
                nextStatus: context.state().status
            };
        }
    });

    await runtime.execute({
        kind: 'configure',
        commandId: 'configure-redaction',
        config: {
            redaction: {
                secretValues: ['secret-token', 'hidden-body']
            }
        }
    });
    runtime.recordEvent({
        kind: 'message',
        topic: 'rallar.test.ready',
        payload: {
            state: 'ready'
        }
    });

    return await runtime.execute({
        kind: 'parallel',
        commandId: 'composite-root',
        continueOnFailure: true,
        maxConcurrency: 1,
        groups: [
            {
                groupId: 'left',
                commands: [
                    {
                        kind: 'loop',
                        commandId: 'inner-loop',
                        count: 2,
                        continueOnFailure: true,
                        commands: [
                            {
                                kind: 'rtc.send',
                                commandId: 'position-send',
                                send: {
                                    frame: '{loop.iteration}'
                                }
                            }
                        ]
                    }
                ]
            },
            {
                groupId: 'right',
                commands: [
                    {
                        kind: 'wait',
                        commandId: 'wait-ready',
                        match: {
                            topic: 'rallar.test.ready',
                            payloadPath: 'state',
                            equals: 'ready'
                        }
                    },
                    {
                        kind: 'assert',
                        commandId: 'assert-event-count',
                        source: 'events.length',
                        operator: 'gte',
                        expected: 1
                    }
                ]
            }
        ]
    });
}

describe('rallar-bb-test composite result helpers', () => {
    it('flattens nested loop/parallel results with stable result and source paths', async () => {
        const fixture = readFixture();
        const result = await runNestedCompositeResult();
        const entries = toRallarBlackBoxCompositeResultFlatEntries([result]);
        const tree = toRallarBlackBoxCompositeResultTree([result]);
        const summary = computeRallarBlackBoxCompositeResultSummary([result], {});
        const firstFailure = resolveRallarBlackBoxCompositeFirstFailure([result]);

        expect(entries.map((entry) => entry.path)).toEqual(fixture.paths);
        expect(entries.map((entry) => entry.sourceRecipePath)).toEqual(fixture.sourceRecipePaths);
        expect(summary).toEqual(fixture.summary);
        expect(toTreeShape(tree)).toEqual(fixture.tree);
        expect(firstFailure?.path).toBe('$.groups[0=left].commands[0].iterations[2].commands[0]');
        expect(firstFailure?.position).toEqual({
            kind: 'loop-child',
            parentPath: '$.groups[0=left].commands[0]',
            parentCommandId: 'composite-root:g1:left:c1:inner-loop',
            childIndex: 1,
            commandIndex: 0,
            originalCommandId: 'position-send',
            iteration: 2
        });
    });

    it('produces chronological timelines and redacted display-safe entries', async () => {
        const fixture = readFixture();
        const result = await runNestedCompositeResult();
        const timeline = toRallarBlackBoxCompositeResultTimeline([result]);
        const display = toRallarBlackBoxCompositeDisplayResults([result], {
            secretValues: ['secret-token', 'hidden-body']
        });
        const redactedFailure = display.find((entry) => entry.status === 'failed');

        expect(timeline.map((entry) => entry.startedAtEpochMs)).toEqual(
            [...timeline.map((entry) => entry.startedAtEpochMs)].sort((left, right) => left - right)
        );
        expect(redactedFailure).toMatchObject(fixture.redactedFailure);
        expect(JSON.stringify(display)).not.toContain('secret-token');
        expect(JSON.stringify(display)).not.toContain('hidden-body');
    });

    it('focuses first failure on the failed child when the composite parent also fails', async () => {
        let sendCount = 0;
        const runtime = createRallarBlackBoxTestRuntime({
            commandExecutor: (command, context) => {
                if (command.kind !== 'rtc.send') {
                    return undefined;
                }
                sendCount += 1;
                return sendCount === 2
                    ? {
                        status: 'failed',
                        error: {
                            code: 'SEND_FAILED',
                            message: 'Synthetic child failure.'
                        },
                        nextStatus: 'failed'
                    }
                    : {
                        status: 'ok',
                        value: {
                            sent: true
                        },
                        nextStatus: context.state().status
                    };
            }
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'fail-fast-loop',
            count: 3,
            commands: [{ kind: 'rtc.send', commandId: 'send-frame' }]
        });
        const firstFailure = resolveRallarBlackBoxCompositeFirstFailure([result]);

        expect(result.status).toBe('failed');
        expect(firstFailure?.commandId).toBe('fail-fast-loop:i2:c1:send-frame');
        expect(firstFailure?.path).toBe('$.iterations[2].commands[0]');
        expect(firstFailure?.depth).toBe(1);
    });

    it('walks the loop children that decode and reports each child that does not record its position', () => {
        const loop: RallarBlackBoxTestResult = {
            ...toLeafResult('loop-partly-positioned'),
            kind: 'loop',
            value: {
                commandId: 'loop-partly-positioned',
                iterations: 1,
                childResultCount: 2,
                passed: 2,
                failed: 0,
                cancelled: false,
                results: [
                    {
                        commandId: 'loop-partly-positioned:i1:c1:send',
                        parentCommandId: 'loop-partly-positioned',
                        path: '$.iterations[1].commands[0]',
                        sourceRecipePath: '$.commands[0]',
                        childIndex: 0,
                        commandIndex: 0,
                        iteration: 1,
                        result: toLeafResult('loop-partly-positioned:i1:c1:send')
                    },
                    {
                        commandId: 'loop-partly-positioned:i1:c2:send',
                        commandIndex: 1,
                        iteration: 1,
                        result: toLeafResult('loop-partly-positioned:i1:c2:send')
                    }
                ]
            }
        };

        const entries = toRallarBlackBoxCompositeResultFlatEntries([loop]);

        expect(entries.map((entry) => entry.path)).toEqual(['$', '$.iterations[1].commands[0]']);
        expect(entries[0].childDecodeIssues).toEqual([{
            valuePath: 'value.results[1]',
            invalidFields: ['parentCommandId', 'path', 'sourceRecipePath', 'childIndex']
        }]);
        expect(entries[1].childDecodeIssues).toEqual([]);
        expect(computeRallarBlackBoxCompositeResultSummary([loop], {}).childDecodeIssueCount).toBe(1);
    });

    it('walks the parallel children that decode and reports an undecodable child result and a group without children', () => {
        const parallel: RallarBlackBoxTestResult = {
            ...toLeafResult('parallel-partly-decodable'),
            kind: 'parallel',
            value: {
                commandId: 'parallel-partly-decodable',
                groupCount: 2,
                maxConcurrency: 1,
                passed: 2,
                failed: 0,
                cancelled: false,
                groups: [
                    {
                        groupId: 'g',
                        commandCount: 2,
                        passed: 2,
                        failed: 0,
                        cancelled: false,
                        durationMs: 1,
                        results: [
                            toParallelChild({ commandId: 'c', commandIndex: 0, result: toLeafResult('c') }),
                            toParallelChild({ commandId: 'd', commandIndex: 1, result: { commandId: 'd', kind: 'rtc.send' } })
                        ]
                    },
                    { groupId: 'h', commandCount: 0, passed: 0, failed: 0, cancelled: false, durationMs: 0 }
                ]
            }
        };

        const entries = toRallarBlackBoxCompositeResultFlatEntries([parallel]);

        expect(entries.map((entry) => entry.path)).toEqual(['$', '$.groups[0=g].commands[0]']);
        expect(entries[0].childDecodeIssues).toEqual([
            { valuePath: 'value.groups[0].results[1]', invalidFields: ['result'] },
            { valuePath: 'value.groups[1]', invalidFields: ['results'] }
        ]);
        expect(computeRallarBlackBoxCompositeResultSummary([parallel], {}).childDecodeIssueCount).toBe(2);
    });

    it('reports a composite value that records no child list, but not one without a value or with compacted children', () => {
        const recordedWithoutChildren: RallarBlackBoxTestResult = {
            ...toLeafResult('loop-without-results'),
            kind: 'loop',
            value: { commandId: 'loop-without-results', iterations: 1 }
        };
        const withoutValue: RallarBlackBoxTestResult = { ...toLeafResult('parallel-without-value'), kind: 'parallel' };
        const compacted: RallarBlackBoxTestResult = {
            ...toLeafResult('loop-compacted'),
            kind: 'loop',
            value: { commandId: 'loop-compacted', iterations: 1, resultCount: 2, failureCount: 0, resultsOmitted: true }
        };

        const entries = toRallarBlackBoxCompositeResultFlatEntries([recordedWithoutChildren, withoutValue, compacted]);

        expect(entries.map((entry) => [entry.path, entry.childDecodeIssues])).toEqual([
            ['$.results[0]', [{ valuePath: 'value', invalidFields: ['results'] }]],
            ['$.results[1]', []],
            ['$.results[2]', []]
        ]);
    });
});
