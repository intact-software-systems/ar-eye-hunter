import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';

import { createRecipeHttpPort, type RecipeSegmentInput } from './api-v1-recipe-causal-prerequisite-fixture.ts';
import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

const GROUP_NAMES = ['One', 'Two', 'Three', 'Four', 'Five'];
const BASIS = { groupRevision: 117, presenceRevision: 41, version: 30, state: 'active' };
const OUTPUTS: ApiJsonObject = {
    ownerAuthHeader: 'Bearer owner-test',
    ownerClientId: 'owner',
    ...Object.fromEntries(GROUP_NAMES.flatMap((name) => [
        [`group${name}Id`, `group-${name.toLowerCase()}`],
        [`finalGroup${name}IdStateCausalRevision`, 119],
        [`finalGroup${name}IdPresenceCausalRevision`, 41]
    ]))
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('medium-scale final reference settlement', () => {
    it.each([
        'missing status',
        'stale epoch',
        'stale status group revision',
        'stale status presence revision',
        'stale status version',
        'inactive status basis',
        'inactive condition',
        'unaccepted layout',
        'stale accepted snapshot',
        'old planned presence',
        'missing planned session',
        'wrong planned session',
        'wrong final config',
        'pending replan'
    ])('cannot finalize capture with %s', async (invalid) => {
        const report = await runSettlement(invalid);
        expect(report.summary.failure).toBeGreaterThan(0);
        expect(report.resultsByName.assertFinalTopologyEffectsConverged[0].status).toBe('FAILURE');
        expect(report.resultsByName.captureoneFinalStateRevision).toBeUndefined();
        expect(report.resultsByName.verifyoneGroupAcrossCluster).toBeUndefined();
    });

    it('waits for the current accepted layout and published series before capturing the exact revision', async () => {
        const report = await runSettlement('missing status', true);
        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.captureoneSettledGroup5[0].actual.body.causalRevision).toEqual({ groupRevision: 119, presenceRevision: 41 });
    });

    it.each([119, 120])('compares the later cross-node snapshot exactly against reference119: received%s', async (revision) => {
        const http = createRecipeHttpPort(({ method, path }) =>
            method === 'POST'
                ? Response.json({ status: 'queued', groupRef: toGroupRef(path), requestId: 'unused', outboxId: 'unused' })
                : Response.json(toGroup(path, '', revision))
        );
        const pending = executeSegment({
            recipe: 'api-v1-state-medium-scale-churn',
            start: 'verifyoneGroupAcrossCluster',
            end: 'verifyfiveGroupAcrossCluster',
            outputs: OUTPUTS,
            fetch: http.fetch
        });
        await vi.runAllTimersAsync();
        const report = await pending;
        expect(report.resultsByName.verifyoneGroupAcrossCluster[0].status).toBe(revision === 119 ? 'SUCCESS' : 'FAILURE');
        expect(report.summary.failure).toBe(revision === 119 ? 0 : 1);
    });
});

async function runSettlement(invalid: string, settles = false) {
    const http = createRecipeHttpPort(({ path, atEpochMs }) => {
        const observedInvalid = settles && atEpochMs >= 20_000 ? '' : invalid;
        return Response.json(path.endsWith('/topology') ? toTopology(path, observedInvalid) : toGroup(path, observedInvalid, 119));
    });
    const pending = executeSegment({
        recipe: 'api-v1-state-medium-scale-churn',
        start: 'pollFinalTopologyEffects',
        end: 'verifyfiveGroupAcrossCluster',
        outputs: { ...OUTPUTS, ...Object.fromEntries(GROUP_NAMES.map((name) => [`finalGroup${name}IdStateCausalRevision`, 117])) },
        fetch: http.fetch
    });
    await vi.runAllTimersAsync();
    return pending;
}

function toGroupRef(path: string) {
    return { applicationId: 'causal-app', workspaceId: 'causal-workspace', groupId: path.split('/groups/')[1].split('/')[0] };
}

function toGroup(path: string, invalid: string, revision: number): ApiJsonObject {
    const basis = { ...BASIS };
    if (invalid === 'stale status group revision') {
        basis.groupRevision = 116;
    }
    if (invalid === 'stale status presence revision') {
        basis.presenceRevision = 40;
    }
    if (invalid === 'stale status version') {
        basis.version = 29;
    }
    if (invalid === 'inactive status basis') {
        basis.state = 'removed';
    }
    return {
        activeSessions: Array.from({ length: 101 }, (_, index) => ({ sessionId: `session-${index}` })),
        memberCount: 101,
        onlineMemberCount: 101,
        causalRevision: { groupRevision: revision, presenceRevision: 41 },
        group: {
            groupId: toGroupRef(path).groupId,
            formationEpoch: 0,
            acceptedLayoutIdentity: invalid === 'unaccepted layout' ? null : BASIS,
            activationStatus: invalid === 'missing status' ? null : {
                condition: invalid === 'inactive condition' ? 'degraded' : 'active',
                formationEpoch: invalid === 'stale epoch' ? 1 : 0,
                coverageBasisLayoutIdentity: basis
            }
        }
    };
}

function toTopology(path: string, invalid: string): ApiJsonObject {
    const snapshot = {
        groupRef: toGroupRef(path),
        state: 'active',
        topology: invalid === 'wrong final config' ? 'star' : 'mesh',
        degreeLimit: 6,
        sourceGroupStateCausalRevision: { groupRevision: 117, presenceRevision: invalid === 'old planned presence' ? 40 : 41 },
        version: 30,
        activeSessionIds: Array.from(
            { length: invalid === 'missing planned session' ? 100 : 101 },
            (_, index) => invalid === 'wrong planned session' && index === 100 ? 'obsolete-session' : `session-${index}`
        )
    };
    return {
        snapshot,
        acceptedSnapshot: { ...snapshot, version: invalid === 'stale accepted snapshot' ? 29 : 30 },
        pending: invalid === 'pending replan' ? { reconfigureQueued: true } : null
    };
}

function executeSegment(input: RecipeSegmentInput) {
    const recipe = readApiV1Recipe(`tests/api-v1/${input.recipe}.json`);
    const steps = recipe.steps ?? [];
    const start = steps.findIndex(({ name }) => name === input.start);
    const end = steps.findIndex(({ name }) => name === input.end);
    if (start < 0 || end < start) {
        throw new Error(`Missing medium-scale segment ${input.start}..${input.end}`);
    }
    return executeBlackBox(
        toExecutableInteractions({
            ...recipe,
            variables: {
                rallarApiBaseUrl: 'http://primary.test',
                rallarApiBaseUrlSecondary: 'http://secondary.test',
                rallarApiBaseUrlTertiary: 'http://tertiary.test',
                applicationId: 'causal-app',
                workspaceId: 'causal-workspace',
                runId: 'semantic'
            },
            steps: [
                ...Object.entries(input.outputs).map(([output, value]) => ({ name: `seed-${output}`, type: 'set', output, value })),
                ...steps.slice(start, end + 1)
            ]
        }),
        0,
        { failFast: true, dependencies: { now: Date.now, createUuid: () => 'settlement-test', fetch: input.fetch } }
    );
}
