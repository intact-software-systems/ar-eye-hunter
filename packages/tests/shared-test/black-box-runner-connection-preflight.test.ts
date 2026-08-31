import { describe, expect, it } from 'vitest';

import { explainBlackBoxRunnerPlan, type BlackBoxRunnerPreflightInput } from '@shared-test/black-box-runner/preflight/plan-preflight.ts';

describe('runtime-selected connection preflight', () => {
    it('validates both literal branches of a preceding SET selection', () => {
        const report = explainConnections([
            selectConnection('wsAlice', 'wsBob'),
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections).toEqual({
            defined: ['wsAlice', 'wsBob'],
            referenced: ['wsAlice', 'wsBob'],
            missing: []
        });
        expect(report.issues.filter((issue) => issue.code === 'MISSING_CONNECTION')).toEqual([]);
    });

    it('rejects an undeclared connection in either conditional branch', () => {
        for (const branches of [['wsMissing', 'wsBob'], ['wsAlice', 'wsMissing']]) {
            const report = explainConnections([
                selectConnection(branches[0], branches[1]),
                sendThrough('{reporter.connection}')
            ]);
            expect(report.connections.missing).toEqual(['wsMissing']);
        }
    });

    it('does not approve future, unbounded, or missing output paths', () => {
        expect(
            explainConnections([
                sendThrough('{reporter.connection}'),
                selectConnection('wsAlice', 'wsBob')
            ]).connections.missing
        ).toEqual(['{reporter.connection}']);
        expect(
            explainConnections([
                selectConnection('wsAlice', { path: 'outputs.remoteConnection' }),
                sendThrough('{reporter.connection}')
            ]).connections.missing
        ).toEqual(['{reporter.connection}']);
        expect(
            explainConnections([
                selectConnection('wsAlice', 'wsBob'),
                sendThrough('{reporter.typo}')
            ]).connections.missing
        ).toEqual(['{reporter.typo}']);
    });

    it('invalidates bounded output knowledge when a later request overwrites it', () => {
        const report = explainConnections([
            selectConnection('wsAlice', 'wsBob'),
            { HTTP: { request: { output: 'reporter', path: 'https://example.invalid' } } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not mistake mixed transform keys for literal connection-bearing objects', () => {
        const selection = selectConnection('wsAlice', 'wsBob');
        Object.assign(selection.SET.request.transform.if.then, { path: 'outputs.remote' });
        const report = explainConnections([selection, sendThrough('{reporter.connection}')]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('rejects dependencies on another parallel branch or an ambiguous post-join value', () => {
        const report = explainConnections([{
            PARALLEL: {
                request: {
                    groups: [
                        { steps: [selectConnection('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] },
                        { steps: [sendThrough('{reporter.connection}')] }
                    ]
                }
            }
        }, sendThrough('{reporter.connection}')]);
        expect(report.connections.referenced).toEqual(['wsAlice', 'wsBob', '{reporter.connection}']);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it.each([false, true])('rejects sibling overwrites even with a branch-local selection: %s', (localSelection) => {
        const report = explainConnections([
            selectConnection('wsAlice', 'wsBob'),
            {
                PARALLEL: {
                    request: {
                        maxConcurrency: 1,
                        groups: [
                            { steps: [selectConnection('wsMissing', 'wsMissing')] },
                            { steps: [...(localSelection ? [selectConnection('wsAlice', 'wsBob')] : []), sendThrough('{reporter.connection}')] }
                        ]
                    }
                }
            }
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not approve a direct output overwritten by a named extraction in the same SET', () => {
        const selection = selectConnection('wsAlice', 'wsBob');
        Object.assign(selection.SET.request, { outputs: { reporter: { transform: { path: 'outputs.remote' } } } });
        expect(explainConnections([selection, sendThrough('{reporter.connection}')]).connections.missing)
            .toEqual(['{reporter.connection}']);
    });

    it.each(['variables', 'outputs', 'results', 'resultsList', 'resultsByName', 'runnerRunId', 'correlation'])(
        'does not shadow the reserved resolver root %s',
        (name) => {
            const selection = selectConnection('wsAlice', 'wsBob');
            selection.SET.request.output = name;
            expect(explainConnections([selection, sendThrough(`{${name}.connection}`)]).connections.missing)
                .toEqual([`{${name}.connection}`]);
        }
    );

    it('still rejects unknown static connection names', () => {
        expect(explainConnections([sendThrough('wsMissing')]).connections.missing).toEqual(['wsMissing']);
    });

    it.each([
        { output: '{target}', value: { connection: 'wsMissing' } },
        { output: 'dummy', value: { connection: 'wsMissing' }, outputs: '{extractions}' }
    ])('invalidates knowledge after an unresolved output write: %j', (request) => {
        const report = explainConnections([
            selectConnection('wsAlice', 'wsBob'),
            { SET: { request } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('rejects branch-local knowledge when a sibling can write any output', () => {
        const report = explainConnections([{
            PARALLEL: {
                request: {
                    groups: [
                        { steps: [{ SET: { request: { output: '{target}', value: {} } } }] },
                        { steps: [selectConnection('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] }
                    ]
                }
            }
        }]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not approve derive branches subsequently replaced by outputPath extraction', () => {
        const selection = selectConnection('wsAlice', 'wsBob');
        const report = explainConnections([
            { SET: { request: { output: 'reporter', derive: selection.SET.request.transform, outputPath: 'alternate' } } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not assume a selection succeeded when the run continues after failure', () => {
        const report = explainConnections([selectConnection('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')], false);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it.each([true, '{continuePolicy}'])('does not assume a nonblocking selection succeeded: %s', (nonBlockingFailure) => {
        const selection = selectConnection('wsAlice', 'wsBob');
        Object.assign(selection.SET.request, { nonBlockingFailure });
        expect(explainConnections([selection, sendThrough('{reporter.connection}')]).connections.missing)
            .toEqual(['{reporter.connection}']);
    });

    it.each([{ failFast: false }, { nonBlockingFailure: true }, { failFast: '{continuePolicy}' }, { nonBlockingFailure: '{continuePolicy}' }])(
        'honors parallel failure continuation: %j',
        (policy) => {
            const report = explainConnections([{
                PARALLEL: {
                    request: {
                        ...policy,
                        groups: [
                            { steps: [selectConnection('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] }
                        ]
                    }
                }
            }]);
            expect(report.connections.missing).toEqual(['{reporter.connection}']);
        }
    );

    it('checks CRDT connection references as well as WebSocket references', () => {
        const report = explainConnections([{ CRDT: { request: { connection: 'wsMissing', action: 'open' } } }]);
        expect(report.connections.missing).toEqual(['wsMissing']);
    });

    it('does not turn an unresolved placeholder into a valid literal connection name', () => {
        const report = explainBlackBoxRunnerPlan({
            rawConfig: { connections: { '{reporter.connection}': { type: 'ws' } }, steps: [] },
            executableInteractions: [sendThrough('{reporter.connection}')]
        });
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });
});

function explainConnections(executableInteractions: BlackBoxRunnerPreflightInput['executableInteractions'], failFast = true) {
    return explainBlackBoxRunnerPlan({
        rawConfig: { connections: { wsAlice: { type: 'ws' }, wsBob: { type: 'ws' } }, steps: [], execution: { failFast } },
        executableInteractions,
        profile: 'strict'
    });
}

function selectConnection(first: string | { readonly path: string; }, second: string | { readonly path: string; }) {
    return {
        SET: {
            request: {
                output: 'reporter',
                transform: {
                    if: {
                        condition: { operator: 'lexicallyBefore', values: [{ path: 'outputs.a' }, { path: 'outputs.b' }] },
                        then: { connection: first },
                        else: { connection: second }
                    }
                }
            }
        }
    };
}

function sendThrough(connection: string) {
    return { WS: { request: { action: 'send', connection } } };
}
