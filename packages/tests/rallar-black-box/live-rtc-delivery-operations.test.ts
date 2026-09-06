import {
    describe,
    expect,
    it,
    vi
} from 'vitest';
import type { LiveRtcControlPort } from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts';

const config = {
    apiBaseUrl: 'http://localhost:18080',
    applicationId: 'app/a',
    workspaceId: 'work b',
    messagesRtcTypeId: 'type',
    messagesRtcTopicId: 'topic'
};

describe('live RTC delivery owner', () => {
    it('creates the managed room and joins each non-owner with scoped request identities', async () => {
        const recording = new RecordingLiveRtcControl();
        const ids = await createLiveRtcDeliveryOperations(config).setupGroupMembership({
            control: recording,
            runId: 'run',
            owner: recording.agents[0],
            members: recording.agents,
            groupId: 'room/c',
            suffix: 'try/d'
        });
        expect(ids).toEqual(['group-create-try/d', 'group-join-B-try/d', 'group-join-C-try/d']);
        expect(recording.commands.map(({ agentId, command }) => ({ agentId, command }))).toEqual([
            {
                agentId: 'A',
                command: expect.objectContaining({
                    kind: 'http.request',
                    request: {
                        path: '/api/state/apps/app%2Fa/workspaces/work%20b/groups/requests/rtc-b06-create-try%2Fd',
                        method: 'POST',
                        body: {
                            groupId: 'room/c',
                            displayName: 'room/c',
                            description: 'Created by rallar-black-box live three-browser matrix',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: '{auth.clientId}',
                            metadata: { source: 'rallar-black-box', matrix: 'live-three-browser', suffix: 'try/d' },
                            lifecyclePolicy: {
                                preset: 'managed',
                                admission: { mode: 'open' },
                                activation: { mode: 'manual' },
                                establishment: {
                                    planTrigger: { kind: 'manual' },
                                    connectTrigger: { kind: 'manual' }
                                }
                            }
                        }
                    }
                })
            },
            ...['B', 'C'].map((agentId) => ({
                agentId,
                command: expect.objectContaining({
                    kind: 'http.request',
                    request: {
                        path:
                            `/api/state/apps/app%2Fa/workspaces/work%20b/groups/room%2Fc/members/{auth.clientId}/requests/rtc-b06-member-${agentId.toLowerCase()}-try%2Fd`,
                        method: 'PUT',
                        body: { status: 'active' }
                    }
                })
            }))
        ]);
    });

    it('runs the retention formation and reconnect paths before sending to the returned session', async () => {
        const recording = new RecordingLiveRtcControl();
        const operations = createLiveRtcDeliveryOperations(config);
        const formation = await operations.runGroupFormation({
            control: recording,
            runId: 'run',
            agents: recording.agents,
            transport: 'messages.rtc',
            groupId: 'room/c',
            suffix: 'try/d',
            readinessScope: 'all'
        });
        const reconnect = await operations.reconnectAndWaitForPeerReadiness({
            control: recording,
            runId: 'run',
            reconnectingAgent: recording.agents[2],
            survivingAgents: [recording.agents[0], recording.agents[1]],
            survivingSessionIds: [formation.sessions.A, formation.sessions.B],
            transport: 'messages.rtc',
            groupId: 'room/c',
            suffix: 'again'
        });
        expect(formation.sessions).toEqual({ A: 'session-A-1', B: 'session-B-1', C: 'session-C-1' });
        expect(reconnect.sessionId).toBe('session-C-2');
        await operations.sendMatrixPayload({
            control: recording,
            runId: 'run',
            sender: recording.agents[1],
            transport: 'messages.rtc',
            groupId: 'room/c',
            suffix: 'again',
            deliveryMode: 'direct',
            targetSessionIds: [reconnect.sessionId],
            matrixId: 'reconnect-result'
        });
        expect(recording.commands.at(-1)?.command).toMatchObject({
            kind: 'rtc.send',
            roomRef: { applicationId: 'app/a', workspaceId: 'work b', groupId: 'room/c' },
            send: { nextHopPeerIds: ['session-C-2'], payload: { matrixId: 'reconnect-result' } }
        });
        const beforeC = recording.milestones.slice(0, recording.milestones.indexOf('connect:C'));
        expect(beforeC).toEqual(expect.arrayContaining(['connect-layout:2', 'ready:A', 'ready:B', 'activate:2']));
        const firstCIndex = recording.milestones.indexOf('connect:C');
        const reconnectCIndex = recording.milestones.indexOf('connect:C', firstCIndex + 1);
        const afterC = recording.milestones.slice(firstCIndex, reconnectCIndex);
        expect(afterC.indexOf('reconfigure')).toBeGreaterThan(afterC.indexOf('presence:3'));
        expect(afterC.indexOf('planned')).toBeGreaterThan(afterC.indexOf('reconfigure'));
        expect(afterC.indexOf('connect-layout:3')).toBeGreaterThan(afterC.indexOf('planned'));
        expect(afterC.indexOf('activate:3')).toBeGreaterThan(afterC.indexOf('connect-layout:3'));
        for (const prefix of ['A', 'B', 'C']) {
            const membershipRefreshIndex = afterC.indexOf(`refresh:${prefix}`);
            const readinessRefreshIndex = afterC.lastIndexOf(`refresh:${prefix}`);
            expect(membershipRefreshIndex).toBeGreaterThan(afterC.indexOf('presence:3'));
            expect(membershipRefreshIndex).toBeLessThan(afterC.indexOf('reconfigure'));
            expect(readinessRefreshIndex).toBeGreaterThan(afterC.indexOf('activate:3'));
            expect(afterC.indexOf(`ready:${prefix}`)).toBeGreaterThan(readinessRefreshIndex);
            expect(recording.milestones.indexOf('send')).toBeGreaterThan(
                recording.milestones.lastIndexOf(`ready:${prefix}`)
            );
        }
        expect(recording.commands.filter(({ command }) => 'request' in command).map(({ command }) => command))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    request: {
                        path: '/api/state/apps/app%2Fa/workspaces/work%20b/groups/room%2Fc/topology/config/requests/topology-mesh-messages-rtc-try%2Fd-all',
                        method: 'PUT',
                        body: { config: { topologyKind: 'mesh', degreeLimit: 2 } }
                    }
                }),
                expect.objectContaining({
                    request: {
                        path: '/api/state/apps/app%2Fa/workspaces/work%20b/groups/room%2Fc/lifecycle/activate/requests/activate-messages-rtc-try%2Fd',
                        method: 'POST',
                        body: {}
                    }
                })
            ]));
    });

    it('waits concurrently for both survivors and the replacement session before returning reconnect readiness', async () => {
        const recording = new RecordingLiveRtcControl();
        const operations = createLiveRtcDeliveryOperations(config);
        const formation = await operations.runGroupFormation({
            control: recording,
            runId: 'replacement-run',
            agents: recording.agents,
            transport: 'messages.rtc',
            groupId: 'replacement-room',
            suffix: 'initial',
            readinessScope: 'all'
        });
        await recording.executeOk({
            runId: 'replacement-run',
            agentId: recording.agents[2].agentId,
            commandId: 'close-original-c',
            command: { kind: 'close' }
        });
        recording.deferReadinessObservations();

        const reconnectPromise = operations.reconnectAndWaitForPeerReadiness({
            control: recording,
            runId: 'replacement-run',
            reconnectingAgent: recording.agents[2],
            survivingAgents: [recording.agents[0], recording.agents[1]],
            survivingSessionIds: [formation.sessions.A, formation.sessions.B],
            transport: 'messages.rtc',
            groupId: 'replacement-room',
            suffix: 'replacement'
        });

        await waitForPendingReadiness(recording, ['A', 'B', 'C']);
        expect(recording.readinessObservations.slice(-3)).toEqual([
            { agentPrefix: 'A', expectedPeerIds: ['session-C-2'] },
            { agentPrefix: 'B', expectedPeerIds: ['session-C-2'] },
            { agentPrefix: 'C', expectedPeerIds: [formation.sessions.A, formation.sessions.B] }
        ]);
        recording.completeNextReadiness('A', 30);
        recording.completeNextReadiness('B', 40);
        let reconnectResolved = false;
        void reconnectPromise.then(() => {
            reconnectResolved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reconnectResolved).toBe(false);
        recording.completeNextReadiness('C', 50);

        await expect(reconnectPromise).resolves.toEqual({
            commandId: 'connect-c-messages-rtc-replacement',
            sessionId: 'session-C-2',
            receiverReadinessDurationMs: 40
        });
    });

    it('promotes new pair sessions before readiness when an active group retains old accepted sessions', async () => {
        const recording = new RecordingLiveRtcControl({
            lifecycleState: 'active',
            acceptedSessions: ['previous-A', 'previous-B', 'previous-C']
        });
        const formation = await createLiveRtcDeliveryOperations(config).runGroupFormation({
            control: recording,
            runId: 'reused-run',
            agents: recording.agents,
            transport: 'messages.rtc',
            groupId: 'reused-room',
            suffix: 'second-transport',
            readinessScope: 'all'
        });
        expect(formation.sessions).toEqual({ A: 'session-A-1', B: 'session-B-1', C: 'session-C-1' });
        const pair = recording.milestones.slice(0, recording.milestones.indexOf('connect:C'));
        expect(pair.indexOf('reconfigure')).toBeGreaterThan(pair.indexOf('presence:2'));
        expect(pair.indexOf('planned')).toBeGreaterThan(pair.indexOf('reconfigure'));
        expect(pair.indexOf('connect-layout:2')).toBeGreaterThan(pair.indexOf('planned'));
        for (const prefix of ['A', 'B']) {
            expect(pair.indexOf(`ready:${prefix}`)).toBeGreaterThan(pair.indexOf('connect-layout:2'));
            expect(pair.indexOf('activate:2')).toBeGreaterThan(pair.indexOf(`ready:${prefix}`));
        }
    });

    it('hydrates every accepted route after activation while owner scope emits only owner readiness', async () => {
        const recording = new RecordingLiveRtcControl();
        recording.deferReadinessObservations();
        const operations = createLiveRtcDeliveryOperations(config);
        const formationPromise = operations.runGroupFormation({
            control: recording,
            runId: 'run',
            agents: recording.agents,
            transport: 'messages.rtc',
            groupId: 'room',
            suffix: 'post-activation',
            readinessScope: 'owner'
        });

        await waitForPendingReadiness(recording, ['A', 'B']);
        expect(recording.milestones).not.toContain('activate:2');
        recording.completeNextReadiness('A', 11);
        await Promise.resolve();
        expect(recording.milestones).not.toContain('activate:2');
        recording.completeNextReadiness('B', 12);

        await waitForPendingReadiness(recording, ['A', 'B']);
        const initialPairActivationIndex = recording.milestones.lastIndexOf('activate:2');
        for (const prefix of ['A', 'B'] as const) {
            const refreshIndex = recording.milestones.lastIndexOf(`refresh:${prefix}`);
            expect(refreshIndex).toBeGreaterThan(initialPairActivationIndex);
            expect(recording.milestones.lastIndexOf(`ready-start:${prefix}`)).toBeGreaterThan(refreshIndex);
        }
        recording.completeNextReadiness('A', 21);
        await Promise.resolve();
        expect(recording.milestones).not.toContain('connect:C');
        recording.completeNextReadiness('B', 22);

        await vi.waitFor(() => expect(recording.milestones).toContain('activate:3'));
        await waitForPendingReadiness(recording, ['A', 'B', 'C']);
        const activationIndex = recording.milestones.lastIndexOf('activate:3');
        for (const prefix of ['A', 'B', 'C'] as const) {
            const refreshIndex = recording.milestones.lastIndexOf(`refresh:${prefix}`);
            expect(refreshIndex).toBeGreaterThan(activationIndex);
            expect(recording.milestones.lastIndexOf(`ready-start:${prefix}`)).toBeGreaterThan(refreshIndex);
        }
        let formationResolved = false;
        void formationPromise.then(() => {
            formationResolved = true;
        });
        recording.completeNextReadiness('A', 41);
        await Promise.resolve();
        expect(formationResolved).toBe(false);
        recording.completeNextReadiness('B', 42);
        await Promise.resolve();
        expect(formationResolved).toBe(false);
        recording.completeNextReadiness('C', 43);
        const formation = await formationPromise;

        expect(formation.readinessDurations).toEqual({ A: 41 });
        await operations.sendMatrixPayload({
            control: recording,
            runId: 'run',
            sender: recording.agents[0],
            transport: 'messages.rtc',
            groupId: 'room',
            suffix: 'post-activation',
            deliveryMode: 'multicast',
            targetSessionIds: ['session-B-1', 'session-C-1'],
            matrixId: 'post-activation-delivery'
        });
        expect(recording.milestones.indexOf('send')).toBeGreaterThan(
            recording.milestones.lastIndexOf('ready-complete:C')
        );
    });

    it('retires peers only after close/reset and survivor absence confirmation', async () => {
        const recording = new RecordingLiveRtcControl();
        await createLiveRtcDeliveryOperations(config).closeAndResetSettledAgentTrio({
            control: recording,
            runId: 'run',
            agents: recording.agents,
            suffix: 'retire',
            sessions: { A: 'session-A', B: 'session-B', C: 'session-C' }
        });
        expect(recording.milestones).toEqual([
            'close:C',
            'reset:C',
            'absent:A:session-C',
            'absent:B:session-C',
            'close:B',
            'reset:B',
            'absent:A:session-B',
            'close:A',
            'reset:A'
        ]);
    });

    it.each(['realtime', 'messages.rtc'] as const)('executes every %s sender/delivery permutation only after activation', async (transport) => {
        const recording = new RecordingLiveRtcControl();
        const result = await createLiveRtcDeliveryOperations(config).runAllDeliveryPermutations({
            control: recording,
            runId: 'run',
            agents: recording.agents,
            transport,
            groupId: 'room',
            suffix: 'all'
        });
        expect(result.scenarios.map(({ senderAgentId, deliveryMode, expectedAgentIds }) => [senderAgentId, deliveryMode, expectedAgentIds])).toEqual([
            ['A', 'direct', ['B']],
            ['A', 'direct', ['C']],
            ['A', 'multicast', ['B', 'C']],
            ['A', 'broadcast', ['B', 'C']],
            ['B', 'direct', ['A']],
            ['B', 'direct', ['C']],
            ['B', 'multicast', ['A', 'C']],
            ['B', 'broadcast', ['A', 'C']],
            ['C', 'direct', ['A']],
            ['C', 'direct', ['B']],
            ['C', 'multicast', ['A', 'B']],
            ['C', 'broadcast', ['A', 'B']]
        ]);
        expect(result.timings.filter(({ kind }) => kind === 'peer-ready').map(({ senderAgentId }) => senderAgentId)).toEqual(['A', 'B', 'C']);
        expect(recording.milestones.indexOf('activate:3')).toBeLessThan(recording.milestones.indexOf('send'));
        expect(recording.messageObservations).toHaveLength(18);
        for (const scenario of result.scenarios) {
            expect(recording.messageObservations.filter(({ matrixId }) => matrixId === scenario.matrixId).map(({ agentId }) => agentId)).toEqual(
                scenario.expectedAgentIds
            );
        }
    });
});

namespace RecordingLiveRtcControl {
    export interface InitialState {
        readonly lifecycleState: 'forming' | 'active';
        readonly acceptedSessions: readonly string[];
    }
}

async function waitForPendingReadiness(
    recording: RecordingLiveRtcControl,
    prefixes: readonly LiveRtcControlClient.FormationAgent['prefix'][]
): Promise<void> {
    await vi.waitFor(() => {
        expect(prefixes.map((prefix) => recording.pendingReadinessCount(prefix))).toEqual(
            prefixes.map(() => 1)
        );
    });
}

class RecordingLiveRtcControl implements LiveRtcControlPort {
    readonly commands: LiveRtcControlClient.ExecuteInput[] = [];
    readonly milestones: string[] = [];
    readonly connected = new Set<string>();
    private lifecycleState: 'forming' | 'active' | 'connecting' | 'reconfiguring';
    private acceptedSessions: readonly string[];
    private formationEpoch = 0;
    private groupRevision = 0;
    private deferReadiness = false;
    private readonly connectionCountByAgentId = new Map<string, number>();
    private readonly sessionIdByAgentId = new Map<string, string>();
    private readonly pendingReadiness = new Map<LiveRtcControlClient.FormationAgent['prefix'], Array<(durationMs: number) => void>>();
    readonly messageObservations: LiveRtcControlClient.WaitForMessageInput[] = [];
    readonly readinessObservations: Array<
        Readonly<{
            agentPrefix: LiveRtcControlClient.FormationAgent['prefix'];
            expectedPeerIds: readonly string[];
        }>
    > = [];
    readonly agents: readonly [LiveRtcControlClient.FormationAgent, LiveRtcControlClient.FormationAgent, LiveRtcControlClient.FormationAgent] = [
        this.createAgent('A'),
        this.createAgent('B'),
        this.createAgent('C')
    ];
    constructor(initial: RecordingLiveRtcControl.InitialState = { lifecycleState: 'forming', acceptedSessions: [] }) {
        this.lifecycleState = initial.lifecycleState;
        this.acceptedSessions = initial.acceptedSessions;
    }

    deferReadinessObservations(): void {
        this.deferReadiness = true;
    }

    pendingReadinessCount(prefix: LiveRtcControlClient.FormationAgent['prefix']): number {
        return this.pendingReadiness.get(prefix)?.length ?? 0;
    }

    completeNextReadiness(
        prefix: LiveRtcControlClient.FormationAgent['prefix'],
        durationMs: number
    ): void {
        const pending = this.pendingReadiness.get(prefix)?.shift();
        if (!pending) {
            throw new Error(`No pending readiness observation for ${prefix}`);
        }
        pending(durationMs);
    }

    private createAgent(prefix: 'A' | 'B' | 'C'): LiveRtcControlClient.FormationAgent {
        return {
            prefix,
            agentId: prefix,
            actor: prefix,
            connection: prefix,
            refreshRoom: async () => {
                this.milestones.push(`refresh:${prefix}`);
            }
        };
    }
    executeOk = async (input: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
        this.commands.push(input);
        const command = input.command;
        const body = this.recordCommand(input, command);
        const sessionId = this.sessionIdByAgentId.get(input.agentId);
        return {
            agentId: input.agentId,
            commandId: input.commandId,
            ok: true,
            result: {
                value: {
                    body,
                    ...(sessionId
                        ? {
                            sessionId,
                            message: { message: { id: { msgId: 'attempted-message', senderId: sessionId } } }
                        }
                        : {})
                }
            }
        };
    };
    executeResult = this.executeOk;
    private recordCommand(
        input: LiveRtcControlClient.ExecuteInput,
        command: LiveRtcControlClient.ExecuteInput['command']
    ): ReturnType<LiveRtcControlPort['resultValue']> {
        if (command.kind === 'rtc.connect') {
            this.recordConnection(input.agentId);
        }
        else if (command.kind === 'rtc.send') {
            this.milestones.push('send');
        }
        else if (command.kind === 'close' || command.kind === 'reset') {
            this.milestones.push(`${command.kind}:${input.agentId}`);
            this.connected.delete(input.agentId);
        }
        else {
            return this.recordHttpCommand(input, command);
        }
        return {};
    }

    private recordConnection(agentId: string): void {
        if (agentId === 'C' && this.lifecycleState !== 'active') {
            throw new Error('Third agent connected before pair activation');
        }
        const connectionCount = (this.connectionCountByAgentId.get(agentId) ?? 0) + 1;
        this.connectionCountByAgentId.set(agentId, connectionCount);
        this.sessionIdByAgentId.set(agentId, `session-${agentId}-${connectionCount}`);
        this.connected.add(agentId);
        if (this.lifecycleState === 'active' && connectionCount > 1) {
            this.acceptedSessions = [...this.connected].map((id) => this.requireConnectedSessionId(id));
        }
        this.milestones.push(`connect:${agentId}`);
    }

    private recordHttpCommand(
        input: LiveRtcControlClient.ExecuteInput,
        command: LiveRtcControlClient.ExecuteInput['command']
    ): ReturnType<LiveRtcControlPort['resultValue']> {
        const request = 'request' in command ? command.request : undefined;
        if (input.commandId.startsWith('group-presence')) {
            this.milestones.push(`presence:${this.connected.size}`);
            return {
                activeSessions: [...this.connected].map((id) => ({
                    sessionId: this.requireConnectedSessionId(id)
                }))
            };
        }
        if (request?.path?.endsWith('/topology')) {
            this.milestones.push('planned');
            return {
                snapshot: {
                    sourceGroupStateCausalRevision: {
                        groupRevision: this.groupRevision,
                        presenceRevision: this.connected.size
                    },
                    version: 1,
                    state: 'active',
                    activeSessionIds: [...this.connected].map((id) => this.requireConnectedSessionId(id))
                }
            };
        }
        if (request?.method === 'GET') {
            return { group: { lifecycleState: this.lifecycleState } };
        }
        return this.recordLifecycleRequest(request?.path);
    }

    private recordLifecycleRequest(
        requestPath: string | undefined
    ): ReturnType<LiveRtcControlPort['resultValue']> {
        if (requestPath?.includes('/topology/config/')) {
            this.milestones.push('mesh');
        }
        else if (requestPath?.includes('/lifecycle/plan/')) {
            this.formationEpoch++;
            this.groupRevision++;
            this.lifecycleState = 'connecting';
            this.milestones.push('plan');
            return {
                group: { formationEpoch: this.formationEpoch },
                causalRevision: { groupRevision: this.groupRevision }
            };
        }
        else if (requestPath?.includes('/lifecycle/reconfigure/')) {
            this.formationEpoch++;
            this.groupRevision++;
            this.lifecycleState = 'reconfiguring';
            this.milestones.push('reconfigure');
            return {
                group: { formationEpoch: this.formationEpoch },
                causalRevision: { groupRevision: this.groupRevision }
            };
        }
        else if (requestPath?.includes('/lifecycle/connect/')) {
            this.acceptedSessions = [...this.connected].map((id) => this.requireConnectedSessionId(id));
            this.milestones.push(`connect-layout:${this.connected.size}`);
        }
        else if (requestPath?.includes('/lifecycle/activate/')) {
            this.lifecycleState = 'active';
            this.acceptedSessions = [...this.connected].map((id) => this.requireConnectedSessionId(id));
            this.milestones.push(`activate:${this.connected.size}`);
        }
        return {};
    }
    resultValue(result: LiveRtcControlClient.Result): ReturnType<LiveRtcControlPort['resultValue']> {
        const value = result.result?.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Recorded control result must contain an object value');
        }
        return value;
    }
    requireSessionId(result: LiveRtcControlClient.Result): string {
        const value = result.result?.value;
        if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.sessionId === 'string') {
            return value.sessionId;
        }
        throw new Error('Recorded connect result must contain a session ID');
    }
    waitForPeerReadiness = async (input: LiveRtcControlClient.WaitForPeerReadinessInput): Promise<number> => {
        await input.agent.refreshRoom({ timeoutMs: 60_000 });
        const dialableSessions = this.acceptedSessions.length > 0
            ? this.acceptedSessions
            : [...this.connected].map((id) => this.requireConnectedSessionId(id));
        if (input.expectedPeerIds.some((id) => !dialableSessions.includes(id))) {
            throw new Error('Readiness requested for a peer absent from the dialable layout');
        }
        this.readinessObservations.push({
            agentPrefix: input.agent.prefix,
            expectedPeerIds: input.expectedPeerIds
        });
        this.milestones.push(`ready:${input.agent.prefix}`);
        this.milestones.push(`ready-start:${input.agent.prefix}`);
        if (!this.deferReadiness) {
            this.milestones.push(`ready-complete:${input.agent.prefix}`);
            return 1;
        }
        return await new Promise<number>((resolve) => {
            const pending = this.pendingReadiness.get(input.agent.prefix) ?? [];
            pending.push((durationMs) => {
                this.milestones.push(`ready-complete:${input.agent.prefix}`);
                resolve(durationMs);
            });
            this.pendingReadiness.set(input.agent.prefix, pending);
        });
    };
    waitForPeerAbsence = async (input: LiveRtcControlClient.WaitForPeerAbsenceInput): Promise<void> => {
        this.milestones.push(`absent:${input.agent.prefix}:${input.departedPeerIds.join(',')}`);
    };
    waitForMessage = async (input: LiveRtcControlClient.WaitForMessageInput): Promise<number> => {
        this.messageObservations.push(input);
        return 1;
    };
    readyPeerIds(): string[] {
        return [];
    }

    private requireConnectedSessionId(agentId: string): string {
        const sessionId = this.sessionIdByAgentId.get(agentId);
        if (!sessionId) {
            throw new Error(`Connected agent ${agentId} has no recorded session ID`);
        }
        return sessionId;
    }
}
