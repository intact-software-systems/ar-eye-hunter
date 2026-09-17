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
    type RallarBlackBoxTestResult
} from '../../shared-test/rallar-bb-test/mod.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

interface CompositeResultTreeShape {
    readonly path: string;
    readonly children: readonly CompositeResultTreeShape[];
}

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

    it('walks no loop child that does not record its path, parent and index', () => {
        const loop: RallarBlackBoxTestResult = {
            ...toLeafResult('loop-without-positions'),
            kind: 'loop',
            value: {
                commandId: 'loop-without-positions',
                iterations: 1,
                childResultCount: 1,
                passed: 1,
                failed: 0,
                cancelled: false,
                results: [{
                    commandId: 'loop-without-positions:i1:c1:send',
                    commandIndex: 0,
                    result: toLeafResult('loop-without-positions:i1:c1:send')
                }]
            }
        };

        expect(toRallarBlackBoxCompositeResultFlatEntries([loop]).map((entry) => entry.path)).toEqual(['$']);
    });

    it('walks no parallel child whose result does not decode', () => {
        const parallel: RallarBlackBoxTestResult = {
            ...toLeafResult('parallel-undecodable-child'),
            kind: 'parallel',
            value: {
                commandId: 'parallel-undecodable-child',
                groupCount: 1,
                maxConcurrency: 1,
                passed: 1,
                failed: 0,
                cancelled: false,
                groups: [{
                    groupId: 'g',
                    commandCount: 1,
                    passed: 1,
                    failed: 0,
                    cancelled: false,
                    durationMs: 1,
                    results: [{
                        commandId: 'c',
                        parentCommandId: 'parallel-undecodable-child',
                        path: '$.groups[0=g].commands[0]',
                        sourceRecipePath: '$.groups[0].commands[0]',
                        childIndex: 0,
                        commandIndex: 0,
                        groupId: 'g',
                        groupIndex: 0,
                        result: { commandId: 'c', kind: 'rtc.send' }
                    }]
                }]
            }
        };

        expect(toRallarBlackBoxCompositeResultFlatEntries([parallel]).map((entry) => entry.path)).toEqual(['$']);
    });
});
