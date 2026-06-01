import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxTestRuntime,
    findFirstFailedRallarBlackBoxCompositeResult,
    flattenRallarBlackBoxCompositeResults,
    summarizeRallarBlackBoxCompositeResults,
    toRallarBlackBoxCompositeDisplayResults,
    toRallarBlackBoxCompositeResultTimeline,
    toRallarBlackBoxCompositeResultTree,
    type RallarBlackBoxCompositeResultTreeNode,
    type RallarBlackBoxTestResult,
} from '../../shared-test/rallar-bb-test/mod.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixturePath = path.join(
    repoRoot,
    'packages/tests/shared-test/fixtures/rallar-bb-test/composite-result-summary-v1.json',
);

function readFixture(): Record<string, unknown> {
    return JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
}

function treeShape(nodes: readonly RallarBlackBoxCompositeResultTreeNode[]): unknown {
    return nodes.map(node => ({
        path: node.entry.path,
        children: treeShape(node.children),
    }));
}

async function executeNestedCompositeResult(): Promise<RallarBlackBoxTestResult> {
    let now = 1_000;
    const runtime = createRallarBlackBoxTestRuntime({
        now: () => now++,
        commandExecutor: (command, context) => {
            if (command.kind !== 'rtc.send') {
                return undefined;
            }

            const loop = command.metadata?.loop as { iteration?: number } | undefined;
            if (loop?.iteration === 2) {
                return {
                    status: 'failed',
                    error: {
                        code: 'SEND_FAILED',
                        message: 'Synthetic send failure.',
                        details: {
                            token: 'secret-token',
                            body: 'contains hidden-body',
                        },
                    },
                    nextStatus: 'failed',
                };
            }

            return {
                status: 'ok',
                value: {
                    sent: true,
                    password: 'secret-token',
                    metadata: command.metadata,
                },
                nextStatus: context.state().status,
            };
        },
    });

    await runtime.execute({
        kind: 'configure',
        commandId: 'configure-redaction',
        config: {
            redaction: {
                secretValues: ['secret-token', 'hidden-body'],
            },
        },
    });
    runtime.recordEvent({
        kind: 'message',
        topic: 'rallar.test.ready',
        payload: {
            state: 'ready',
        },
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
                                    frame: '{loop.iteration}',
                                },
                            },
                        ],
                    },
                ],
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
                            equals: 'ready',
                        },
                    },
                    {
                        kind: 'assert',
                        commandId: 'assert-event-count',
                        source: 'events.length',
                        operator: 'gte',
                        expected: 1,
                    },
                ],
            },
        ],
    });
}

describe('rallar-bb-test composite result helpers', () => {
    it('flattens nested loop/parallel results with stable result and source paths', async () => {
        const fixture = readFixture();
        const result = await executeNestedCompositeResult();
        const entries = flattenRallarBlackBoxCompositeResults(result);
        const tree = toRallarBlackBoxCompositeResultTree(result);
        const summary = summarizeRallarBlackBoxCompositeResults(result);
        const firstFailure = findFirstFailedRallarBlackBoxCompositeResult(result);

        expect(entries.map(entry => entry.path)).toEqual(fixture.paths);
        expect(entries.map(entry => entry.sourceRecipePath)).toEqual(fixture.sourceRecipePaths);
        expect(summary).toEqual(fixture.summary);
        expect(treeShape(tree)).toEqual(fixture.tree);
        expect(firstFailure?.path).toBe('$.groups[0=left].commands[0].iterations[2].commands[0]');
        expect(firstFailure?.originalCommandId).toBe('position-send');
        expect(firstFailure?.parentCommandId).toBe('composite-root:g1:left:c1:inner-loop');
    });

    it('produces chronological timelines and redacted display-safe entries', async () => {
        const fixture = readFixture();
        const result = await executeNestedCompositeResult();
        const timeline = toRallarBlackBoxCompositeResultTimeline(result);
        const display = toRallarBlackBoxCompositeDisplayResults(result, {
            redaction: {
                secretValues: ['secret-token', 'hidden-body'],
            },
        });
        const redactedFailure = display.find(entry => entry.status === 'failed');

        expect(timeline.map(entry => entry.startedAtEpochMs)).toEqual(
            [...timeline.map(entry => entry.startedAtEpochMs)].sort((left, right) => left - right),
        );
        expect(redactedFailure).toMatchObject(fixture.redactedFailure as Record<string, unknown>);
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
                            message: 'Synthetic child failure.',
                        },
                        nextStatus: 'failed',
                    }
                    : {
                        status: 'ok',
                        value: {
                            sent: true,
                        },
                        nextStatus: context.state().status,
                    };
            },
        });

        const result = await runtime.execute({
            kind: 'loop',
            commandId: 'fail-fast-loop',
            count: 3,
            commands: [{ kind: 'rtc.send', commandId: 'send-frame' }],
        });
        const firstFailure = findFirstFailedRallarBlackBoxCompositeResult(result);

        expect(result.status).toBe('failed');
        expect(firstFailure?.commandId).toBe('fail-fast-loop:i2:c1:send-frame');
        expect(firstFailure?.path).toBe('$.iterations[2].commands[0]');
        expect(firstFailure?.depth).toBe(1);
    });
});
