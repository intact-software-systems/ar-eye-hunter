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
});
