import { describe, expect, it } from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { explainBlackBoxRunnerPlan } from '../../shared-test/black-box-runner/preflight/plan-preflight.ts';

function strictIssueCodes(step: ApiJsonObject): readonly string[] {
    const plan = explainBlackBoxRunnerPlan({
        rawConfig: { steps: [step] },
        profile: 'strict'
    } as never);

    return (plan.issues ?? []).map((issue: { code: string; }) => issue.code);
}

const PARALLEL_GROUPS = [{ name: 'alpha', steps: [] }];

describe('strict preflight expectation checks', () => {
    // The runner compares a parallel step's expect against its aggregate, so a
    // gate that rejects one would block the capability rather than report a
    // dropped assertion.
    it('accepts an expectation on a parallel step', () => {
        expect(strictIssueCodes({
            name: 'race',
            type: 'parallel',
            request: { maxConcurrency: 2 },
            groups: PARALLEL_GROUPS,
            expect: { comparators: [{ path: 'success', lte: 2 }] }
        })).not.toContain('STRICT_EXPECT_IGNORED');
    });

    it('accepts a body expectation on a parallel step', () => {
        expect(strictIssueCodes({
            name: 'race',
            type: 'parallel',
            request: { maxConcurrency: 2 },
            groups: PARALLEL_GROUPS,
            expect: { body: { groupCount: 2, failure: 0 } }
        })).not.toContain('STRICT_EXPECT_IGNORED');
    });

    // The keys a WebSocket send genuinely never reads still have to be caught,
    // or the lint stops doing the job it was added for.
    it('still reports an absence expectation on a websocket send', () => {
        expect(strictIssueCodes({
            name: 'sendAndHope',
            type: 'ws.send',
            request: { action: 'send', connection: 'wsAlice', message: {} },
            expect: { absent: { id: { msgId: 'never' } } }
        })).toContain('STRICT_EXPECT_IGNORED');
    });

    it('still reports an empty expected array under a compatible comparison', () => {
        expect(strictIssueCodes({
            name: 'readGroup',
            type: 'http',
            request: { method: 'GET', path: '/api/state/groups/g' },
            expect: { body: { managerPrincipalIds: [] } }
        })).toContain('STRICT_EXPECT_VACUOUS');
    });

    // The HTTP evaluator reads only status/statusCode/statusCodes and bodyAnyOf,
    // and a 2xx answer with no expected status passes, so an HTTP `anyOf` used
    // to assert nothing without ever failing.
    it('reports an anyOf on an HTTP step, which the HTTP evaluator never reads', () => {
        expect(strictIssueCodes({
            name: 'raceOneCommand',
            type: 'http',
            request: { method: 'POST', path: '/api/thing/requests/http-any-of-probe-aaaa' },
            expect: { anyOf: [{ status: 200 }, { status: 409 }] }
        })).toContain('STRICT_EXPECT_IGNORED');
    });

    it('accepts the statusCodes list that expresses the same thing', () => {
        expect(strictIssueCodes({
            name: 'raceOneCommand',
            type: 'http',
            request: { method: 'POST', path: '/api/thing/requests/http-status-codes-probe-aaaa' },
            expect: { statusCodes: [200, 409] }
        })).not.toContain('STRICT_EXPECT_IGNORED');
    });

    it('leaves anyOf on an assert step alone', () => {
        expect(strictIssueCodes({
            name: 'theCommandWasAnswered',
            type: 'assert',
            actual: { status: 200 },
            expect: { anyOf: [{ status: 200 }, { status: 409 }] }
        })).not.toContain('STRICT_EXPECT_IGNORED');
    });

    // An output declared inside a parallel group resolves for every later step
    // exactly as a top-level one does; the collector read only the top level and
    // reported every such output as missing.
    it('sees an output produced inside a parallel group', () => {
        const plan = explainBlackBoxRunnerPlan({
            rawConfig: {
                steps: [
                    {
                        name: 'raceTwoCommands',
                        type: 'parallel',
                        groups: [{
                            name: 'first',
                            steps: [{
                                name: 'commandOne',
                                type: 'http',
                                request: {
                                    method: 'POST',
                                    path: '/api/thing/requests/parallel-output-probe-aaaa',
                                    outputs: { firstStatus: 'statusCode' }
                                },
                                expect: { status: 200 }
                            }]
                        }]
                    },
                    {
                        name: 'readTheCapturedStatus',
                        type: 'assert',
                        actual: { seen: '{firstStatus}' },
                        expect: { body: { seen: 200 } }
                    }
                ]
            },
            profile: 'strict'
        } as never);

        expect((plan.issues ?? []).map((issue: { code: string; }) => issue.code))
            .not.toContain('MISSING_OUTPUT_REFERENCE');
    });
});
