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
import {
    toExecutableInteractions,
    type ExecutableInteraction
} from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';
import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface PresenceRecipeBoundary {
    readonly name: string;
    readonly start: string;
    readonly end: string;
    readonly groupId: string;
    readonly transportState: 'flowing' | 'halted';
    readonly bobGenerationId: string;
    readonly messageId: string;
}

interface PresenceRecipeRequest {
    readonly method: string;
    readonly url: string;
    readonly atEpochMs: number;
    readonly body: string | undefined;
    readonly headers: Headers;
}

interface PresenceRecipeFrame {
    readonly text: string;
    readonly atEpochMs: number;
}

const BOUNDARIES: readonly PresenceRecipeBoundary[] = [
    {
        name: 'blocked',
        start: 'connectAlicePresence',
        end: 'blockedSendIsNackedBeforeActivation',
        groupId: 'blocked',
        transportState: 'flowing',
        bobGenerationId: 'generation-semantic',
        messageId: 'data-policy-blocked-semantic'
    },
    {
        name: 'allowed',
        start: 'connectAlicePresenceAllowed',
        end: 'allowedSendReachesAliceWhileForming',
        groupId: 'allowed',
        transportState: 'flowing',
        bobGenerationId: 'generation-semantic',
        messageId: 'data-policy-allowed-forming-semantic'
    },
    {
        name: 'default',
        start: 'connectAlicePresenceDefault',
        end: 'defaultDataSendReachesAliceWhileForming',
        groupId: 'default',
        transportState: 'flowing',
        bobGenerationId: 'generation-semantic',
        messageId: 'data-policy-default-forming-semantic'
    },
    {
        name: 'paused rejoin',
        start: 'bobRestoresPresenceAfterPausedRejoin',
        end: 'pausedDataSendDoesNotReachAlice',
        groupId: 'allowed',
        transportState: 'halted',
        bobGenerationId: 'generation-paused-rejoin-semantic',
        messageId: 'data-policy-paused-semantic'
    }
];
const SCOPE = { applicationId: 'presence-app', workspaceId: 'presence-workspace', groupId: 'allowed' };
const AUDIT = { atEpochMs: 0, actor: { kind: 'principal' as const, principalId: 'alice' }, reason: null, traceId: null, requestId: null };
const GROUP: GroupSnapshot['group'] = {
    ...SCOPE,
    status: 'active',
    slug: null,
    displayName: 'Policy room',
    description: null,
    kind: 'room',
    joinMode: 'open',
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 2,
    ownerPrincipalId: 'alice',
    snapshotVersion: 2,
    metadataVersion: 1,
    rosterVersion: 2,
    presenceVersion: 1,
    created: AUDIT,
    updated: AUDIT,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    lifecycleState: 'forming',
    formationEpoch: 0,
    formationAttemptCount: 0,
    lastFormationOutcome: null,
    establishmentStartedAtEpochMs: null,
    formationElectorate: ['alice'],
    acceptedLayoutIdentity: null,
    transportState: 'flowing',
    memberPolicy: { transports: 'rtc-and-ws', maxConcurrentEdgeSetups: 32 },
    activationStatus: null,
    archived: null,
    deleted: null
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    TestWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', TestWebSocket);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe.each(BOUNDARIES)('$name policy recipe admission', (boundary) => {
    it('waits past stale HTTP200 setup until both exact scoped identities converge, then sends once', async () => {
        const matching = toPresenceSnapshot(boundary);
        const stale = { ...matching, activeSessions: matching.activeSessions.filter((session) => session.principalId === 'alice') };
        const http = new PresenceRecipePorts([stale, {
            ...matching,
            members: [...matching.members].reverse(),
            activeSessions: [...matching.activeSessions].reverse()
        }], true);
        const report = await runPresenceRecipe(boundary, http);

        expect(report.summary.failure).toBe(0);
        expect(http.requests.filter(({ method }) => method === 'GET').map(({ url, atEpochMs }) => ({ url, atEpochMs }))).toEqual([
            { url: `http://presence.test/api/state/apps/presence-app/workspaces/presence-workspace/groups/${boundary.groupId}`, atEpochMs: 0 },
            { url: `http://presence.test/api/state/apps/presence-app/workspaces/presence-workspace/groups/${boundary.groupId}`, atEpochMs: 100 }
        ]);
        expect(http.frames).toHaveLength(1);
        expect(http.frames[0].atEpochMs).toBe(100);
        expect(JSON.parse(http.frames[0].text)).toMatchObject({
            id: { msgId: boundary.messageId, senderId: 'bob-session', sessionId: 'bob-session' },
            targets: { groupRef: { ...SCOPE, groupId: boundary.groupId } }
        });
        expect(http.requests.filter(({ method }) => method === 'PUT').map(({ body }) => JSON.parse(body ?? '{}').generationId)).toEqual(
            boundary.name === 'paused rejoin' ? ['generation-paused-rejoin-semantic'] : ['generation-semantic', 'generation-semantic']
        );
        expect(http.requests.filter(({ method }) => method === 'GET').every(({ headers }) => ![...headers.keys()].some((key) => key.includes('revision'))))
            .toBe(true);
    });

    it('accepts already matching admission immediately without repeating the original send', async () => {
        const http = new PresenceRecipePorts([toPresenceSnapshot(boundary)], true);
        const report = await runPresenceRecipe(boundary, http);

        expect(report.summary.failure).toBe(0);
        expect(http.requests.filter(({ method }) => method === 'GET')).toHaveLength(1);
        expect(http.frames).toHaveLength(1);
        expect(http.frames[0].atEpochMs).toBe(0);
    });

    it('keeps the original receive deadline terminal with one send when delivery never arrives', async () => {
        const http = new PresenceRecipePorts([toPresenceSnapshot(boundary)], false);
        const report = await runPresenceRecipe(boundary, http);

        expect(report.summary.failure).toBe(1);
        expect(http.frames).toHaveLength(1);
        expect(report.summary.durationMs).toBe(10000);
        expect(report.resultsByName[boundary.end][0].status).toBe('FAILURE');
    });

    describe.each(['alice', 'bob'])('%s exact identity', (principalId) => {
        it.each(['members', 'activeSessions'] as const)('fails before sending when its %s row is missing', async (collection) => {
            const matching = toPresenceSnapshot(boundary);
            const http = new PresenceRecipePorts([{ ...matching, [collection]: matching[collection].filter((row) => row.principalId !== principalId) }], true);
            const report = await runPresenceRecipe(boundary, http);
            expect(report.summary.failure).toBe(1);
            expect(http.frames).toEqual([]);
            expect(report.resultsByName[boundary.end]).toBeUndefined();
            expect(http.requests.filter(({ method }) => method === 'GET').map(({ atEpochMs }) => atEpochMs)).toEqual([
                0,
                100,
                300,
                700,
                1500,
                3100,
                6300,
                12700
            ]);
        });

        it.each(
            [
                { collection: 'members', field: 'principalId', value: 'other-principal' },
                { collection: 'members', field: 'status', value: 'left' },
                { collection: 'activeSessions', field: 'principalId', value: principalId === 'alice' ? 'bob' : 'alice' },
                { collection: 'activeSessions', field: 'sessionId', value: principalId === 'alice' ? 'bob-session' : 'alice-session' },
                { collection: 'activeSessions', field: 'generationId', value: 'old-generation' },
                { collection: 'activeSessions', field: 'status', value: 'disconnected' },
                { collection: 'activeSessions', field: 'disconnectedAtEpochMs', value: 1 },
                ...(['members', 'activeSessions'] as const).flatMap((collection) =>
                    ['applicationId', 'workspaceId', 'groupId'].map((field) => ({ collection, field, value: 'other-scope' }))
                )
            ] satisfies readonly { collection: 'members' | 'activeSessions'; field: string; value: ApiJsonValue; }[]
        )(
            'rejects mixed or stale $collection / $field despite a two-session count',
            async (wrong) => {
                const matching = toPresenceSnapshot(boundary);
                const snapshot = {
                    ...matching,
                    [wrong.collection]: matching[wrong.collection].map((row) => row.principalId === principalId ? { ...row, [wrong.field]: wrong.value } : row)
                };
                const http = new PresenceRecipePorts([snapshot], true);
                const report = await runPresenceRecipe(boundary, http);
                expect(report.summary.failure).toBe(1);
                expect(http.frames).toEqual([]);
                expect(report.resultsByName[boundary.end]).toBeUndefined();
                expect(http.requests.filter(({ method }) => method === 'GET')).toHaveLength(8);
            }
        );
    });

    it.each([
        { field: 'applicationId', value: 'other-app' },
        { field: 'workspaceId', value: 'other-workspace' },
        { field: 'groupId', value: 'other-group' },
        { field: 'status', value: 'archived' },
        { field: 'lifecycleState', value: 'active' },
        { field: 'transportState', value: 'wrong-transport' }
    ])('fails without a send when durable group $field mismatches', async ({ field, value }) => {
        const matching = toPresenceSnapshot(boundary);
        const http = new PresenceRecipePorts([{ ...matching, group: { ...matching.group, [field]: value } }], true);
        const report = await runPresenceRecipe(boundary, http);

        expect(report.summary.failure).toBe(1);
        expect(http.frames).toEqual([]);
        expect(report.resultsByName[boundary.end]).toBeUndefined();
        expect(http.requests.filter(({ method }) => method === 'GET')).toHaveLength(8);
    });
});

it.each([
    { boundary: BOUNDARIES[0], end: 'crdtSyncRequestFlowsWhileBlocked', messageId: 'data-policy-crdt-exempt-semantic' },
    { boundary: BOUNDARIES[3], end: 'aliceDoesNotReceivePausedData', messageId: 'data-policy-crdt-halted-semantic' }
])('preserves the $boundary.name negative policy, CRDT exemption, and absence window after admission', async ({ boundary, end, messageId }) => {
    const http = new PresenceRecipePorts([toPresenceSnapshot(boundary)], true);
    const report = await runPresenceRecipe({ ...boundary, end }, http);

    expect(report.summary.failure).toBe(0);
    expect(http.frames.map(({ text }) => JSON.parse(text).id.msgId)).toEqual([boundary.messageId, messageId]);
    expect(report.summary.durationMs).toBeGreaterThanOrEqual(4000);
    expect(report.summary.durationMs).toBeLessThanOrEqual(4100);
    expect(http.frames[1].atEpochMs).toBeGreaterThanOrEqual(boundary.name === 'blocked' ? 4000 : 0);
    expect(http.frames[1].atEpochMs).toBeLessThan(boundary.name === 'blocked' ? 4100 : 100);
});

function toPresenceSnapshot(boundary: PresenceRecipeBoundary): GroupSnapshot {
    const scope = { ...SCOPE, groupId: boundary.groupId };
    return {
        causalRevision: { groupRevision: 2, presenceRevision: 1 },
        group: { ...GROUP, ...scope, transportState: boundary.transportState },
        memberCount: 2,
        onlineMemberCount: 2,
        members: ['alice', 'bob'].map((principalId) => ({
            ...scope,
            principalId,
            status: 'active',
            role: 'member',
            joined: AUDIT,
            updated: AUDIT,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: ['alice', 'bob'].map((principalId) => ({
            ...scope,
            principalId,
            sessionId: `${principalId}-session`,
            generationId: principalId === 'alice' ? 'generation-semantic' : boundary.bobGenerationId,
            generationVersion: 1,
            status: 'active',
            connectedAtEpochMs: 0,
            lastHeartbeatAtEpochMs: 0,
            expiresAtEpochMs: 100000,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        }))
    };
}

function readPresenceRecipeInteractions(boundary: PresenceRecipeBoundary): ExecutableInteraction[] {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-group-data-policy.json');
    const steps = recipe.steps ?? [];
    const start = steps.findIndex((step) => step.name === boundary.start);
    const end = steps.findIndex((step) => step.name === boundary.end);
    const setupNames = ['createAliceWsTicket', 'deriveAliceWsUrl', 'openAliceWs', 'createBobWsTicket', 'deriveBobWsUrl', 'openBobWs'];
    const outputs = {
        aliceClientId: 'alice',
        aliceSessionId: 'alice-session',
        aliceAuthHeader: 'Bearer alice-test',
        aliceWsUrl: 'ws://presence.test/alice',
        bobClientId: 'bob',
        bobSessionId: 'bob-session',
        bobAuthHeader: 'Bearer bob-test',
        bobWsUrl: 'ws://presence.test/bob'
    };
    if (start < 0 || end < start) {
        throw new Error(`Missing policy recipe segment ${boundary.start} -> ${boundary.end}`);
    }
    return toExecutableInteractions({
        ...recipe,
        variables: {
            apiPrimary: 'http://presence.test',
            applicationId: SCOPE.applicationId,
            workspaceId: SCOPE.workspaceId,
            groupId: 'blocked',
            allowedGroupId: 'allowed',
            defaultDataGroupId: 'default',
            runId: 'semantic'
        },
        steps: [
            ...Object.entries(outputs).map(([output, value]) => ({ name: `seed-${output}`, type: 'set', output, value })),
            ...steps.filter((step) => step.name === 'openAliceWs' || step.name === 'openBobWs'),
            ...steps.slice(start, end + 1).filter((step) => !setupNames.includes(String(step.name)))
        ]
    });
}

async function runPresenceRecipe(boundary: PresenceRecipeBoundary, http: PresenceRecipePorts): ReturnType<typeof executeBlackBox> {
    const interactions = readPresenceRecipeInteractions(boundary);
    const physicalSend = TestWebSocket.prototype.send;
    vi.spyOn(TestWebSocket.prototype, 'send').mockImplementation(function (this: TestWebSocket, text) {
        physicalSend.call(this, text);
        http.writeSocketFrame(this, String(text));
    });
    const pending = executeBlackBox(interactions, 0, {
        failFast: true,
        dependencies: { now: Date.now, createUuid: () => 'presence-semantic', fetch: http.fetch }
    });
    await vi.advanceTimersByTimeAsync(0);
    TestWebSocket.instances.at(-1)?.open();
    await vi.advanceTimersByTimeAsync(0);
    TestWebSocket.instances.at(-1)?.open();
    await vi.runAllTimersAsync();
    const report = await pending;
    vi.restoreAllMocks();
    TestWebSocket.instances.length = 0;
    vi.setSystemTime(0);
    return report;
}

class PresenceRecipePorts {
    readonly requests: PresenceRecipeRequest[] = [];
    readonly frames: PresenceRecipeFrame[] = [];
    readonly #snapshots: readonly GroupSnapshot[];
    readonly #deliverFrames: boolean;
    #reads = 0;

    constructor(snapshots: readonly GroupSnapshot[], deliverFrames: boolean) {
        this.#snapshots = snapshots;
        this.#deliverFrames = deliverFrames;
    }

    readonly fetch: BlackBoxFetch = async (url, request) => {
        const method = request?.method ?? 'GET';
        this.requests.push({
            method,
            url: String(url),
            atEpochMs: Date.now(),
            body: request?.body ? String(request.body) : undefined,
            headers: new Headers(request?.headers)
        });
        if (method === 'PUT') {
            return Response.json({ ...this.#snapshots[0], activeSessions: [] });
        }
        if (method === 'GET') {
            return Response.json(this.#snapshots[Math.min(this.#reads++, this.#snapshots.length - 1)]);
        }
        throw new Error(`Unexpected presence recipe request ${method} ${String(url)}`);
    };

    writeSocketFrame(socket: TestWebSocket, text: string): void {
        this.frames.push({ text, atEpochMs: Date.now() });
        if (!this.#deliverFrames) {
            return;
        }
        const frame = JSON.parse(text);
        if (frame.id.msgId === 'data-policy-blocked-semantic' || frame.id.msgId === 'data-policy-paused-semantic') {
            socket.receive(JSON.stringify({
                id: { v: 3, msgId: 'test-nack', ts: 0, senderId: 'default-qbox-server' },
                route: { topicId: 'al-control' },
                targets: { mode: 'unicast', toPeerId: 'bob-session' },
                payload: { typeId: 'al.control.nack.v2', resource: JSON.stringify({ msgId: frame.id.msgId, reason: 'unauthorized' }) }
            }));
            return;
        }
        TestWebSocket.instances[0].receive(text);
    }
}
