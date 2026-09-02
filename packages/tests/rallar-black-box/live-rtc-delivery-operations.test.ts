import {
    describe,
    expect,
    it
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
            readinessAgent: recording.agents[1],
            transport: 'messages.rtc',
            groupId: 'room/c',
            suffix: 'again'
        });
        expect(formation.sessions).toEqual({ A: 'session-A', B: 'session-B', C: 'session-C' });
        expect(reconnect.sessionId).toBe('session-C');
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
            send: { nextHopPeerIds: ['session-C'], payload: { matrixId: 'reconnect-result' } }
        });
        const beforeC = recording.milestones.slice(0, recording.milestones.indexOf('connect:C'));
        expect(beforeC).toEqual(expect.arrayContaining(['connect-layout:2', 'ready:A', 'ready:B', 'activate:2']));
        const afterC = recording.milestones.slice(recording.milestones.indexOf('connect:C'));
        expect(afterC.indexOf('reconfigure')).toBeGreaterThan(afterC.indexOf('presence:3'));
        expect(afterC.indexOf('planned')).toBeGreaterThan(afterC.indexOf('reconfigure'));
        expect(afterC.indexOf('connect-layout:3')).toBeGreaterThan(afterC.indexOf('planned'));
        for (const prefix of ['A', 'B', 'C']) {
            expect(afterC.indexOf(`refresh:${prefix}`)).toBeGreaterThan(afterC.indexOf('connect-layout:3'));
            expect(afterC.indexOf(`ready:${prefix}`)).toBeGreaterThan(afterC.indexOf(`refresh:${prefix}`));
            expect(afterC.indexOf('activate:3')).toBeGreaterThan(afterC.indexOf(`ready:${prefix}`));
            expect(afterC.indexOf('send')).toBeGreaterThan(afterC.indexOf(`ready:${prefix}`));
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
        expect(formation.sessions).toEqual({ A: 'session-A', B: 'session-B', C: 'session-C' });
        const pair = recording.milestones.slice(0, recording.milestones.indexOf('connect:C'));
        expect(pair.indexOf('reconfigure')).toBeGreaterThan(pair.indexOf('presence:2'));
        expect(pair.indexOf('planned')).toBeGreaterThan(pair.indexOf('reconfigure'));
        expect(pair.indexOf('connect-layout:2')).toBeGreaterThan(pair.indexOf('planned'));
        for (const prefix of ['A', 'B']) {
            expect(pair.indexOf(`ready:${prefix}`)).toBeGreaterThan(pair.indexOf('connect-layout:2'));
            expect(pair.indexOf('activate:2')).toBeGreaterThan(pair.indexOf(`ready:${prefix}`));
        }
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

class RecordingLiveRtcControl implements LiveRtcControlPort {
    readonly commands: LiveRtcControlClient.ExecuteInput[] = [];
    readonly milestones: string[] = [];
    readonly connected = new Set<string>();
    private lifecycleState: 'forming' | 'active' | 'connecting' | 'reconfiguring';
    private acceptedSessions: readonly string[];
    private formationEpoch = 0;
    private groupRevision = 0;
    readonly messageObservations: LiveRtcControlClient.WaitForMessageInput[] = [];
    readonly agents: readonly [LiveRtcControlClient.FormationAgent, LiveRtcControlClient.FormationAgent, LiveRtcControlClient.FormationAgent] = [
        this.createAgent('A'),
        this.createAgent('B'),
        this.createAgent('C')
    ];
    constructor(initial: RecordingLiveRtcControl.InitialState = { lifecycleState: 'forming', acceptedSessions: [] }) {
        this.lifecycleState = initial.lifecycleState;
        this.acceptedSessions = initial.acceptedSessions;
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
        return {
            agentId: input.agentId,
            commandId: input.commandId,
            ok: true,
            result: {
                value: {
                    body,
                    sessionId: `session-${input.agentId}`,
                    message: { message: { id: { msgId: 'attempted-message', senderId: `session-${input.agentId}` } } }
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
            if (input.agentId === 'C' && this.lifecycleState !== 'active') {
                throw new Error('Third agent connected before pair activation');
            }
            this.connected.add(input.agentId);
            this.milestones.push(`connect:${input.agentId}`);
        }
        else if (command.kind === 'rtc.send') {
            this.milestones.push('send');
        }
        else if (command.kind === 'close' || command.kind === 'reset') {
            this.milestones.push(`${command.kind}:${input.agentId}`);
            this.connected.delete(input.agentId);
        }
        else if (input.commandId.startsWith('group-presence')) {
            this.milestones.push(`presence:${this.connected.size}`);
            return { causalRevision: { presenceRevision: this.connected.size } };
        }
        else if (('request' in command ? command.request?.path : undefined)?.endsWith('/topology')) {
            this.milestones.push('planned');
            return {
                snapshot: {
                    sourceGroupStateCausalRevision: {
                        groupRevision: this.groupRevision,
                        presenceRevision: this.connected.size
                    },
                    version: 1,
                    state: 'active',
                    activeSessionIds: [...this.connected].map((id) => `session-${id}`)
                }
            };
        }
        else if (('request' in command ? command.request?.method : undefined) === 'GET') {
            return { group: { lifecycleState: this.lifecycleState } };
        }
        else if (('request' in command ? command.request?.path : undefined)?.includes('/topology/config/')) {
            this.milestones.push('mesh');
        }
        else if (('request' in command ? command.request?.path : undefined)?.includes('/lifecycle/plan/')) {
            this.formationEpoch++;
            this.groupRevision++;
            this.lifecycleState = 'connecting';
            this.milestones.push('plan');
            return {
                group: { formationEpoch: this.formationEpoch },
                causalRevision: { groupRevision: this.groupRevision }
            };
        }
        else if (('request' in command ? command.request?.path : undefined)?.includes('/lifecycle/reconfigure/')) {
            this.formationEpoch++;
            this.groupRevision++;
            this.lifecycleState = 'reconfiguring';
            this.milestones.push('reconfigure');
            return {
                group: { formationEpoch: this.formationEpoch },
                causalRevision: { groupRevision: this.groupRevision }
            };
        }
        else if (('request' in command ? command.request?.path : undefined)?.includes('/lifecycle/connect/')) {
            this.acceptedSessions = [...this.connected].map((id) => `session-${id}`);
            this.milestones.push(`connect-layout:${this.connected.size}`);
        }
        else if (('request' in command ? command.request?.path : undefined)?.includes('/lifecycle/activate/')) {
            this.lifecycleState = 'active';
            this.acceptedSessions = [...this.connected].map((id) => `session-${id}`);
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
        return `session-${result.agentId}`;
    }
    waitForPeerReadiness = async (input: LiveRtcControlClient.WaitForPeerReadinessInput): Promise<number> => {
        const dialableSessions = this.acceptedSessions.length > 0
            ? this.acceptedSessions
            : [...this.connected].map((id) => `session-${id}`);
        if (input.expectedPeerIds.some((id) => !dialableSessions.includes(id))) {
            throw new Error('Readiness requested for a peer absent from the dialable layout');
        }
        this.milestones.push(`ready:${input.agent.prefix}`);
        return 1;
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
}
