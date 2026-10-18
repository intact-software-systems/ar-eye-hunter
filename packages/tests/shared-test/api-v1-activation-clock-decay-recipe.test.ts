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
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';

import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';
import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface ActivationClockScenario {
    readonly activeStatus: GroupActivationStatus;
    readonly terminalStatus: GroupActivationStatus;
    readonly terminalEvent: GroupActivationStatus | undefined;
    readonly duplicate: boolean;
}

const ACCEPTED_LAYOUT = { groupRevision: 37, presenceRevision: 19, version: 4, state: 'active' } as const;
const ACTIVE: GroupActivationStatus = {
    formationEpoch: 12,
    coverageBasisLayoutIdentity: ACCEPTED_LAYOUT,
    condition: 'active',
    coverageRate: 1,
    evidenceWatermark: { version: 1, createdAtEpochMs: -35000 },
    publishedAtEpochMs: 0
};
const PREDECESSOR: GroupActivationStatus = {
    ...ACTIVE,
    formationEpoch: 11,
    coverageBasisLayoutIdentity: { groupRevision: 36, presenceRevision: 18, version: 3, state: 'active' }
};
const FAILED: GroupActivationStatus = {
    ...ACTIVE,
    condition: 'failed',
    coverageRate: 0,
    evidenceWatermark: null,
    publishedAtEpochMs: 32000
};
const SCENARIO: ActivationClockScenario = {
    activeStatus: ACTIVE,
    terminalStatus: FAILED,
    terminalEvent: FAILED,
    duplicate: false
};
const WRONG_SERIES = [
    { name: 'epoch', status: { ...ACTIVE, formationEpoch: 11 } },
    { name: 'group revision', status: { ...ACTIVE, coverageBasisLayoutIdentity: { ...ACCEPTED_LAYOUT, groupRevision: 36 } } },
    { name: 'presence revision', status: { ...ACTIVE, coverageBasisLayoutIdentity: { ...ACCEPTED_LAYOUT, presenceRevision: 18 } } },
    { name: 'layout version', status: { ...ACTIVE, coverageBasisLayoutIdentity: { ...ACCEPTED_LAYOUT, version: 3 } } },
    { name: 'layout state', status: { ...ACTIVE, coverageBasisLayoutIdentity: { ...ACCEPTED_LAYOUT, state: 'removed' } } }
] as const;

class ActivationClockSocket extends SimulatedWebSocket {
    constructor(url: string) {
        super(url);
        setTimeout(() => void this.open(), 0);
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    SimulatedWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', ActivationClockSocket);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    SimulatedWebSocket.instances.length = 0;
});

describe('API-v1 activation clock decay recipe', () => {
    it('counts the retained active and clock decay in the settled series alongside predecessor publications', async () => {
        const report = await executeClockScenario(SCENARIO);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs).toMatchObject({ activationFormationEpoch: 12, activationAcceptedLayoutIdentity: ACCEPTED_LAYOUT });
        expect(report.resultsByName.theActiveLifecycleNamesTheClockSeries[0]).toMatchObject({ status: 'SUCCESS', pollAttempts: 2 });
        expect(report.resultsByName.theStaleEvidenceStillActivates[0]).toMatchObject({ status: 'SUCCESS', pollAttempts: 2 });
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice[0]).toMatchObject({
            status: 'SUCCESS',
            actual: { matchedCount: 2, waitedMs: 45000 }
        });
        expect(report.resultsByName.theQuietGroupFellBelowTheViableFloor[0].status).toBe('SUCCESS');
    });

    it('rejects an additional current-series publication near the end of the original clock window', async () => {
        const report = await executeClockScenario({ ...SCENARIO, duplicate: true });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice[0]).toMatchObject({
            status: 'FAILURE',
            actual: { matchedCount: 3, waitedMs: 45000 }
        });
        expect(report.resultsByName.theQuietGroupFellBelowTheViableFloor).toBeUndefined();
    });

    it('rejects a clock that never publishes terminal decay', async () => {
        const report = await executeClockScenario({ ...SCENARIO, terminalEvent: undefined });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice[0]).toMatchObject({
            status: 'FAILURE',
            actual: { matchedCount: 1, waitedMs: 45000 }
        });
    });

    it.each(WRONG_SERIES)('does not cross the active barrier with a different $name', async ({ status }) => {
        const report = await executeClockScenario({ ...SCENARIO, activeStatus: status });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.theStaleEvidenceStillActivates[0]).toMatchObject({ status: 'FAILURE', pollExhausted: true });
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice).toBeUndefined();
    });

    it.each(WRONG_SERIES)('does not count a terminal publication with a different $name', async ({ status }) => {
        const report = await executeClockScenario({
            ...SCENARIO,
            terminalEvent: { ...FAILED, formationEpoch: status.formationEpoch, coverageBasisLayoutIdentity: status.coverageBasisLayoutIdentity }
        });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice[0]).toMatchObject({ status: 'FAILURE', actual: { matchedCount: 1 } });
    });

    it.each(WRONG_SERIES)('rejects terminal readback from a different $name after valid WS evidence', async ({ status }) => {
        const report = await executeClockScenario({
            ...SCENARIO,
            terminalStatus: { ...FAILED, formationEpoch: status.formationEpoch, coverageBasisLayoutIdentity: status.coverageBasisLayoutIdentity }
        });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.theClockWritesTheStatusExactlyTwice[0].status).toBe('SUCCESS');
        expect(report.resultsByName.theQuietGroupFellBelowTheViableFloor[0]).toMatchObject({ status: 'FAILURE', pollExhausted: true });
    });
});

async function executeClockScenario(scenario: ActivationClockScenario): ReturnType<typeof executeBlackBox> {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-activation-clock-decay.json');
    const steps = recipe.steps ?? [];
    const reportEdge = steps.findIndex(({ name }) => name === 'reportTheEdgeWithAlreadyStaleEvidence');
    if (reportEdge < 0) {
        throw new Error('Activation clock recipe has no evidence report boundary');
    }
    const interactions = toExecutableInteractions({
        ...recipe,
        variables: { rallarApiBaseUrl: 'http://activation.test', applicationId: 'clock-app', workspaceId: 'clock-workspace', groupId: 'clock-group' },
        steps: [
            { name: 'seedAuth', type: 'set', output: 'aliceAuthHeader', value: 'Bearer clock-test' },
            { name: 'seedClient', type: 'set', output: 'aliceClientId', value: 'alice' },
            { name: 'openAliceWs', type: 'ws.open', connection: 'wsAlice', request: { url: 'ws://activation.test/alice' } },
            ...steps.slice(reportEdge + 1).filter(({ type }) => type !== 'ws.close')
        ]
    });
    const pending = executeBlackBox(interactions, 0, {
        failFast: true,
        dependencies: { now: Date.now, createUuid: () => 'clock-semantic', fetch: createClockHttpPort(scenario) }
    });
    await vi.runAllTimersAsync();
    return pending;
}

function createClockHttpPort(scenario: ActivationClockScenario): BlackBoxFetch {
    let reads = 0;
    return async (url, request) => {
        if (request?.method !== 'GET' || new URL(String(url)).pathname !== '/api/state/apps/clock-app/workspaces/clock-workspace/groups/clock-group') {
            throw new Error('Unexpected activation clock request');
        }
        const socket = SimulatedWebSocket.instances[0];
        if (reads === 0) {
            await socket.receive(toStatusFrame(PREDECESSOR));
            await socket.receive(toStatusFrame(ACTIVE));
            const terminalEvent = scenario.terminalEvent;
            if (terminalEvent) {
                setTimeout(() => void socket.receive(toStatusFrame(terminalEvent)), 32000);
            }
            if (scenario.duplicate) {
                setTimeout(() => void socket.receive(toStatusFrame(ACTIVE)), 44999);
            }
        }
        reads++;
        if (Date.now() >= 45000) {
            return Response.json(toGroupSnapshot('active', scenario.terminalStatus));
        }
        return Response.json(toGroupSnapshot(reads === 1 ? 'connecting' : 'active', reads <= 3 ? PREDECESSOR : scenario.activeStatus));
    };
}

function toGroupSnapshot(lifecycleState: string, activationStatus: GroupActivationStatus): ApiJsonObject {
    return {
        group: {
            groupId: 'clock-group',
            lifecycleState,
            formationEpoch: lifecycleState === 'active' ? 12 : 11,
            acceptedLayoutIdentity: ACCEPTED_LAYOUT,
            activationStatus
        }
    };
}

function toStatusFrame(activationStatus: GroupActivationStatus): string {
    return JSON.stringify({
        route: { topicId: 'group-state.event' },
        payload: {
            typeId: 'group-state.delta.v1',
            contentType: 'application/json',
            resource: JSON.stringify({ event: { eventType: 'group-activation-status-changed' }, ...toGroupSnapshot('active', activationStatus) })
        }
    });
}
