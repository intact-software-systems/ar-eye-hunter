import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { BlackBoxFetch } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface CapturedPresenceLeaseRequest {
    readonly method: string;
    readonly path: string;
    readonly atEpochMs: number;
    readonly body: string | undefined;
}

interface PresenceLeaseHttpPort {
    readonly fetch: BlackBoxFetch;
    readonly requests: CapturedPresenceLeaseRequest[];
}

interface PresenceLeaseInvalidSnapshot {
    readonly name: string;
    readonly changed: ApiJsonObject;
    readonly failure: string;
}

const GROUP_PATH = '/api/state/apps/presence-app/workspaces/presence-workspace/groups/presence-group';
const EXPIRY_EVENT: ApiJsonObject = {
    eventType: 'session-disconnected',
    reason: 'expired',
    causalRevision: { groupRevision: 5, presenceRevision: 2 }
};
const ALICE_SESSION: ApiJsonObject = { sessionId: 'alice-session', principalId: 'alice', status: 'active' };
const MEMBERS: ApiJsonValue[] = [
    { principalId: 'alice', status: 'active' },
    { principalId: 'bob', status: 'active' }
];
const PRIOR_OUTPUTS: ApiJsonObject = {
    aliceClientId: 'alice',
    aliceSessionId: 'alice-session',
    aliceAuthHeader: 'Bearer alice-test',
    bobClientId: 'bob',
    bobSessionId: 'bob-session',
    bobAuthHeader: 'Bearer bob-test',
    presenceRevisionBeforeSweep: 2,
    lifecycleStateBeforeSweep: 'connecting',
    sessionsAtFilter: [ALICE_SESSION],
    presenceRevisionAtFilter: 2
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});

afterEach(() => vi.useRealTimers());

describe('API-v1 presence lease lifecycle recipe', () => {
    it('waits for canonical summary convergence after the expiry event becomes visible', async () => {
        const http = createPresenceLeaseHttpPort([toPresenceSnapshot(2), toPresenceSnapshot(3)], 0);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary, JSON.stringify({ summary: report.summary, requests: http.requests })).toMatchObject({ failure: 0, observedFailure: 0 });
        expect(report.outputs).toMatchObject({
            presenceRevisionAfterSweep: 3,
            lifecycleStateAfterSweep: 'connecting',
            sessionsAfterSweep: [ALICE_SESSION],
            membersAfterSweep: MEMBERS
        });
        expect(http.requests.map(({ method, path, atEpochMs }) => ({ method, path, atEpochMs }))).toEqual([
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 0 },
            { method: 'GET', path: GROUP_PATH, atEpochMs: 0 },
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 2000 },
            { method: 'GET', path: GROUP_PATH, atEpochMs: 2000 },
            { method: 'PUT', path: `${GROUP_PATH}/sessions/bob-session/requests/presencelease-bob-release-semantic`, atEpochMs: 2000 }
        ]);
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({
            status: 'SUCCESS',
            pollAttempts: 2,
            pollExhausted: false,
            pollElapsedMs: 2000
        });
        expect(report.resultsByName.theSweepDroppedPresenceNotMembershipOrTheLifecycle[0]).toMatchObject({
            status: 'SUCCESS',
            actual: { revisionAfterSweep: 3 }
        });
        expect(report.resultsByName.bobCanTakeAFreshLeaseWithoutRejoining[0].status).toBe('SUCCESS');
        expect(JSON.parse(http.requests[4].body ?? '')).toEqual({
            generationId: 'presencelease-generation-two-semantic',
            principalId: 'bob'
        });
    });

    it.each([3, 7])('accepts an already converged revision %i without guessing the next revision', async (revision) => {
        const http = createPresenceLeaseHttpPort([toPresenceSnapshot(revision)], 0);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.presenceRevisionAfterSweep).toBe(revision);
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({ pollAttempts: 1, pollExhausted: false, pollElapsedMs: 0 });
        expect(http.requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'PUT']);
    });

    it('records bounded failure and blocks the fresh lease when canonical summary revision never advances', async () => {
        const http = createPresenceLeaseHttpPort([toPresenceSnapshot(2)], 0);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary).toMatchObject({ failure: 2, observedFailure: 2, nonBlockingFailure: 0, durationMs: 94000 });
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({
            status: 'FAILURE',
            pollAttempts: 48,
            pollExhausted: true,
            pollElapsedMs: 94000
        });
        expect(report.resultsByName.theSweepDroppedPresenceNotMembershipOrTheLifecycle[0]).toMatchObject({
            status: 'FAILURE',
            details: { failures: [{ path: 'revisionAfterSweep', comparator: 'gt', expected: 2, actual: 2 }] }
        });
        expect(http.requests).toHaveLength(96);
        expect(http.requests.every(({ method }) => method === 'GET')).toBe(true);
        expect(report.resultsByName.bobCanTakeAFreshLeaseWithoutRejoining).toBeUndefined();
    });

    it('waits for the named expiry before reading state and refreshes placeholders after a failed assertion', async () => {
        const http = createPresenceLeaseHttpPort([toPresenceSnapshot(2), toPresenceSnapshot(3)], 2);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary).toMatchObject({ failure: 0, observedFailure: 0 });
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({ pollAttempts: 4, pollElapsedMs: 6000 });
        expect(http.requests.map(({ method, path, atEpochMs }) => ({ method, path, atEpochMs }))).toEqual([
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 0 },
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 2000 },
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 4000 },
            { method: 'GET', path: GROUP_PATH, atEpochMs: 4000 },
            { method: 'GET', path: `${GROUP_PATH}/events`, atEpochMs: 6000 },
            { method: 'GET', path: GROUP_PATH, atEpochMs: 6000 },
            { method: 'PUT', path: `${GROUP_PATH}/sessions/bob-session/requests/presencelease-bob-release-semantic`, atEpochMs: 6000 }
        ]);
        expect(report.outputs.presenceRevisionAfterSweep).toBe(3);
    });

    it.each<PresenceLeaseInvalidSnapshot>([
        { name: 'connecting lifecycle', changed: { group: { lifecycleState: 'active' } }, failure: 'theSweepDroppedPresenceNotMembershipOrTheLifecycle' },
        { name: 'live session roster', changed: { activeSessions: [] }, failure: 'theSweepDroppedPresenceNotMembershipOrTheLifecycle' },
        {
            name: 'surviving session identity',
            changed: { activeSessions: [{ sessionId: 'bob-session', principalId: 'bob', status: 'active' }] },
            failure: 'theSweepDroppedPresenceNotMembershipOrTheLifecycle'
        },
        {
            name: 'surviving session status',
            changed: { activeSessions: [{ sessionId: 'alice-session', principalId: 'alice', status: 'disconnected' }] },
            failure: 'theSweepDroppedPresenceNotMembershipOrTheLifecycle'
        },
        {
            name: 'membership roster',
            changed: { members: [{ principalId: 'alice', status: 'active' }] },
            failure: 'theSweepDroppedPresenceNotMembershipOrTheLifecycle'
        },
        { name: 'online member count', changed: { onlineMemberCount: 2 }, failure: 'theSweepAdvancedTheChangeToken' },
        { name: 'member count', changed: { memberCount: 1 }, failure: 'theSweepAdvancedTheChangeToken' }
    ])('rejects an advanced revision with an invalid $name', async ({ changed, failure }) => {
        const http = createPresenceLeaseHttpPort([{ ...toPresenceSnapshot(3), ...changed }], 0);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(
            report.summary.failure,
            JSON.stringify({
                summary: report.summary,
                sessions: report.outputs.sessionsAfterSweep,
                freshLeaseStatus: report.resultsByName.bobCanTakeAFreshLeaseWithoutRejoining?.[0]?.status
            })
        ).toBe(2);
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({ status: 'FAILURE', pollAttempts: 48, pollExhausted: true });
        expect(report.resultsByName[failure][0].status).toBe('FAILURE');
        expect(http.requests.every(({ method }) => method === 'GET')).toBe(true);
        expect(report.resultsByName.bobCanTakeAFreshLeaseWithoutRejoining).toBeUndefined();
    });

    it('shares the original deadline between expiry visibility and canonical summary convergence', async () => {
        const http = createPresenceLeaseHttpPort([toPresenceSnapshot(2)], 46);
        const pending = executePostExpirySequence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary).toMatchObject({ failure: 2, durationMs: 94000 });
        expect(report.resultsByName.expirySummaryConverges[0]).toMatchObject({ pollAttempts: 48, pollExhausted: true, pollElapsedMs: 94000 });
        expect(http.requests.filter(({ path }) => path === GROUP_PATH).map(({ atEpochMs }) => atEpochMs)).toEqual([92000, 94000]);
        expect(http.requests).toHaveLength(50);
        expect(report.resultsByName.bobCanTakeAFreshLeaseWithoutRejoining).toBeUndefined();
    });
});

function executePostExpirySequence(fetch: BlackBoxFetch): ReturnType<typeof executeBlackBox> {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-group-presence-lease-lifecycle.json');
    const steps = recipe.steps ?? [];
    const start = steps.findIndex((step) => step.name === 'theExpiredLeaseLeavesOnlyAliceWithAMonotonicChangeToken');
    if (start < 0) {
        throw new Error('Presence lease recipe is missing its post-expiry observation sequence');
    }
    const interactions = toExecutableInteractions({
        ...recipe,
        variables: {
            rallarApiBaseUrl: 'http://presence-lease.test',
            applicationId: 'presence-app',
            workspaceId: 'presence-workspace',
            groupId: 'presence-group',
            runId: 'semantic'
        },
        steps: [
            ...Object.entries(PRIOR_OUTPUTS).map(([output, value]) => ({ name: `seed-${output}`, type: 'set', output, value })),
            ...steps.slice(start)
        ]
    });
    return executeBlackBox(interactions, 0, {
        failFast: true,
        dependencies: { now: Date.now, createUuid: () => 'presence-lease-semantic', fetch }
    });
}

function toPresenceSnapshot(presenceRevision: number): ApiJsonObject {
    return {
        causalRevision: { groupRevision: 5, presenceRevision },
        group: { lifecycleState: 'connecting' },
        onlineMemberCount: 1,
        memberCount: 2,
        activeSessions: [ALICE_SESSION],
        members: MEMBERS
    };
}

function createPresenceLeaseHttpPort(snapshots: readonly ApiJsonObject[], missingEventReads: number): PresenceLeaseHttpPort {
    const requests: CapturedPresenceLeaseRequest[] = [];
    let eventReads = 0;
    let stateReads = 0;
    const fetch: BlackBoxFetch = async (url, request) => {
        const path = new URL(String(url)).pathname;
        const method = request?.method ?? 'GET';
        requests.push({ method, path, atEpochMs: Date.now(), body: request?.body ? String(request.body) : undefined });
        if (method === 'GET' && path === `${GROUP_PATH}/events`) {
            eventReads++;
            return Response.json(eventReads <= missingEventReads ? [] : [EXPIRY_EVENT]);
        }
        if (method === 'GET' && path === GROUP_PATH) {
            const snapshot = snapshots[Math.min(stateReads++, snapshots.length - 1)];
            return Response.json(snapshot);
        }
        if (method === 'PUT' && path === `${GROUP_PATH}/sessions/bob-session/requests/presencelease-bob-release-semantic`) {
            return Response.json({ ...toPresenceSnapshot(4), onlineMemberCount: 2, activeSessions: [ALICE_SESSION, { sessionId: 'bob-session' }] });
        }
        throw new Error(`Unexpected presence lease request ${method} ${path}`);
    };
    return { fetch, requests };
}
