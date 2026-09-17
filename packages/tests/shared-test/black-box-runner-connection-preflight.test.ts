import { describe, expect, it } from 'vitest';

import { computeBlackBoxRunnerPlanPreflight } from '@shared-test/black-box-runner/preflight/plan-preflight.ts';
import { computeBlackBoxRunnerEnvRequirements } from '@shared-test/black-box-runner/preflight/preflight-env-variables.ts';
import type {
    ApiJsonObject,
    ApiJsonValue
} from '@shared/api/api-json-value.ts';

describe('runtime-selected connection preflight', () => {
    it('validates both literal branches of a preceding SET selection', () => {
        const report = computeConnectionReport([
            toConnectionSelectionStep('wsAlice', 'wsBob'),
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
            const report = computeConnectionReport([
                toConnectionSelectionStep(branches[0], branches[1]),
                sendThrough('{reporter.connection}')
            ]);
            expect(report.connections.missing).toEqual(['wsMissing']);
        }
    });

    it('does not approve future, unbounded, or missing output paths', () => {
        expect(
            computeConnectionReport([
                sendThrough('{reporter.connection}'),
                toConnectionSelectionStep('wsAlice', 'wsBob')
            ]).connections.missing
        ).toEqual(['{reporter.connection}']);
        expect(
            computeConnectionReport([
                toConnectionSelectionStep('wsAlice', { path: 'outputs.remoteConnection' }),
                sendThrough('{reporter.connection}')
            ]).connections.missing
        ).toEqual(['{reporter.connection}']);
        expect(
            computeConnectionReport([
                toConnectionSelectionStep('wsAlice', 'wsBob'),
                sendThrough('{reporter.typo}')
            ]).connections.missing
        ).toEqual(['{reporter.typo}']);
    });

    it('invalidates bounded output knowledge when a later request overwrites it', () => {
        const report = computeConnectionReport([
            toConnectionSelectionStep('wsAlice', 'wsBob'),
            { HTTP: { request: { output: 'reporter', path: 'https://example.invalid' } } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not mistake mixed transform keys for literal connection-bearing objects', () => {
        const selection = toConnectionSelectionStep('wsAlice', 'wsBob');
        Object.assign(selection.SET.request.transform.if.then, { path: 'outputs.remote' });
        const report = computeConnectionReport([selection, sendThrough('{reporter.connection}')]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('rejects dependencies on another parallel branch or an ambiguous post-join value', () => {
        const report = computeConnectionReport([{
            PARALLEL: {
                request: {
                    groups: [
                        { steps: [toConnectionSelectionStep('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] },
                        { steps: [sendThrough('{reporter.connection}')] }
                    ]
                }
            }
        }, sendThrough('{reporter.connection}')]);
        expect(report.connections.referenced).toEqual(['wsAlice', 'wsBob', '{reporter.connection}']);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it.each([false, true])('rejects sibling overwrites even with a branch-local selection: %s', (localSelection) => {
        const report = computeConnectionReport([
            toConnectionSelectionStep('wsAlice', 'wsBob'),
            {
                PARALLEL: {
                    request: {
                        maxConcurrency: 1,
                        groups: [
                            { steps: [toConnectionSelectionStep('wsMissing', 'wsMissing')] },
                            { steps: [...(localSelection ? [toConnectionSelectionStep('wsAlice', 'wsBob')] : []), sendThrough('{reporter.connection}')] }
                        ]
                    }
                }
            }
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not approve a direct output overwritten by a named extraction in the same SET', () => {
        const selection = toConnectionSelectionStep('wsAlice', 'wsBob');
        Object.assign(selection.SET.request, { outputs: { reporter: { transform: { path: 'outputs.remote' } } } });
        expect(computeConnectionReport([selection, sendThrough('{reporter.connection}')]).connections.missing)
            .toEqual(['{reporter.connection}']);
    });

    it.each(['variables', 'outputs', 'results', 'resultsList', 'resultsByName', 'runnerRunId', 'correlation'])(
        'does not shadow the reserved resolver root %s',
        (name) => {
            const selection = toConnectionSelectionStep('wsAlice', 'wsBob');
            selection.SET.request.output = name;
            expect(computeConnectionReport([selection, sendThrough(`{${name}.connection}`)]).connections.missing)
                .toEqual([`{${name}.connection}`]);
        }
    );

    it('still rejects unknown static connection names', () => {
        expect(computeConnectionReport([sendThrough('wsMissing')]).connections.missing).toEqual(['wsMissing']);
    });

    it.each<ApiJsonObject>([
        { output: '{target}', value: { connection: 'wsMissing' } },
        { output: 'dummy', value: { connection: 'wsMissing' }, outputs: '{extractions}' }
    ])('invalidates knowledge after an unresolved output write: %j', (request) => {
        const report = computeConnectionReport([
            toConnectionSelectionStep('wsAlice', 'wsBob'),
            { SET: { request } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('rejects branch-local knowledge when a sibling can write any output', () => {
        const report = computeConnectionReport([{
            PARALLEL: {
                request: {
                    groups: [
                        { steps: [{ SET: { request: { output: '{target}', value: {} } } }] },
                        { steps: [toConnectionSelectionStep('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] }
                    ]
                }
            }
        }]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not approve derive branches subsequently replaced by outputPath extraction', () => {
        const selection = toConnectionSelectionStep('wsAlice', 'wsBob');
        const report = computeConnectionReport([
            { SET: { request: { output: 'reporter', derive: selection.SET.request.transform, outputPath: 'alternate' } } },
            sendThrough('{reporter.connection}')
        ]);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it('does not assume a selection succeeded when the run continues after failure', () => {
        const report = computeConnectionReport([toConnectionSelectionStep('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')], false);
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });

    it.each([true, '{continuePolicy}'])('does not assume a nonblocking selection succeeded: %s', (nonBlockingFailure) => {
        const selection = toConnectionSelectionStep('wsAlice', 'wsBob');
        Object.assign(selection.SET.request, { nonBlockingFailure });
        expect(computeConnectionReport([selection, sendThrough('{reporter.connection}')]).connections.missing)
            .toEqual(['{reporter.connection}']);
    });

    it.each<ApiJsonObject>([{ failFast: false }, { nonBlockingFailure: true }, { failFast: '{continuePolicy}' }, { nonBlockingFailure: '{continuePolicy}' }])(
        'honors parallel failure continuation: %j',
        (policy) => {
            const report = computeConnectionReport([{
                PARALLEL: {
                    request: {
                        ...policy,
                        groups: [
                            { steps: [toConnectionSelectionStep('wsAlice', 'wsBob'), sendThrough('{reporter.connection}')] }
                        ]
                    }
                }
            }]);
            expect(report.connections.missing).toEqual(['{reporter.connection}']);
        }
    );

    it('checks CRDT connection references as well as WebSocket references', () => {
        const report = computeConnectionReport([{ CRDT: { request: { connection: 'wsMissing', action: 'open' } } }]);
        expect(report.connections.missing).toEqual(['wsMissing']);
    });

    it('does not turn an unresolved placeholder into a valid literal connection name', () => {
        const rawConfig = { connections: { '{reporter.connection}': { type: 'ws' } }, steps: [] };
        const report = computeBlackBoxRunnerPlanPreflight({
            rawConfig,
            expandedConfig: rawConfig,
            executableInteractions: [sendThrough('{reporter.connection}')],
            envRequirements: computeBlackBoxRunnerEnvRequirements(rawConfig, {}),
            profile: 'compat'
        });
        expect(report.connections.missing).toEqual(['{reporter.connection}']);
    });
});

function computeConnectionReport(executableInteractions: readonly ApiJsonValue[], failFast = true) {
    const rawConfig = { connections: { wsAlice: { type: 'ws' }, wsBob: { type: 'ws' } }, steps: [], execution: { failFast } };
    return computeBlackBoxRunnerPlanPreflight({
        rawConfig,
        expandedConfig: rawConfig,
        executableInteractions,
        envRequirements: computeBlackBoxRunnerEnvRequirements(rawConfig, {}),
        profile: 'strict'
    });
}

function toConnectionSelectionStep(first: string | { readonly path: string; }, second: string | { readonly path: string; }) {
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
