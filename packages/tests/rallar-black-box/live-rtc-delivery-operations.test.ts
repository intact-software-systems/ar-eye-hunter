import type { BrowserContext, Page } from '@playwright/test';
import type { ALNackPayload } from '@shared/al-contracts/al-control.ts';
import { describe, expect, it } from 'vitest';
import type { RtcBaselineJson } from '../../../packages/shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';
import type { LiveRtcControlPort } from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import { createLiveRtcDeliveryOperations, hasReceiverNotInSyncNack } from '../../../tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-performance-evidence.ts';

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
                            lifecyclePolicy: { preset: 'managed', admission: { mode: 'open' }, activation: { mode: 'manual' } }
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
        expect(recording.milestones).toEqual([
            'connect:A',
            'presence:1',
            'connect:B',
            'presence:2',
            'connect:C',
            'presence:3',
            'mesh',
            'establish',
            'planned',
            'refresh:A',
            'refresh:B',
            'refresh:C',
            'ready:A',
            'ready:B',
            'ready:C',
            'activate',
            'refresh:A',
            'refresh:B',
            'refresh:C',
            'connect:C',
            'ready:B',
            'send'
        ]);
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

    it('rejects a successful enqueue with no receiver NACK even when its command id names a NACK', async () => {
        const recording = new RecordingLiveRtcControl();
        await expect(
            createLiveRtcDeliveryOperations(config).runNackProbe({
                control: recording,
                runId: 'run',
                agent: recording.agents[0],
                groupId: 'room',
                suffix: 'nack-not-yet-in-sync',
                targetSessionId: 'session-B'
            })
        ).rejects.toThrow('Expected receiver-correlated');
    }, 35_000);

    it('requires the actual receiver and message on a not-yet-in-sync receipt', () => {
        const expected = { messageId: 'message', senderId: 'sender', receiverId: 'receiver' };
        const receipt = { msgId: 'message', fromPeerId: 'receiver', toPeerId: 'sender', reason: 'not-yet-in-sync' as const, observedAtEpochMs: 12 };
        expect(hasReceiverNotInSyncNack([receipt], expected)).toBe(true);
        expect(hasReceiverNotInSyncNack([], expected)).toBe(false);
        expect(hasReceiverNotInSyncNack([{ ...receipt, msgId: 'another' }], expected)).toBe(false);
        expect(hasReceiverNotInSyncNack([{ ...receipt, fromPeerId: 'unrelated' }], expected)).toBe(false);
        expect(hasReceiverNotInSyncNack([{ ...receipt, toPeerId: 'unrelated' }], expected)).toBe(false);
        expect(hasReceiverNotInSyncNack([{ ...receipt, reason: 'expired' }], expected)).toBe(false);
    });

    it('accepts the independently supplied receiver receipt for the actual attempted message', async () => {
        const recording = new RecordingLiveRtcControl();
        recording.nacks.push({
            msgId: 'attempted-message',
            fromPeerId: 'session-B',
            toPeerId: 'session-A',
            reason: 'not-yet-in-sync',
            observedAtEpochMs: 12
        });
        expect(
            await createLiveRtcDeliveryOperations(config).runNackProbe({
                control: recording,
                runId: 'run',
                agent: recording.agents[0],
                groupId: 'room',
                suffix: 'positive',
                targetSessionId: 'session-B'
            })
        ).toBe('nack-not-yet-in-sync-positive');
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
        expect(recording.milestones.indexOf('activate')).toBeLessThan(recording.milestones.indexOf('send'));
        expect(recording.messageObservations).toHaveLength(18);
        for (const scenario of result.scenarios) {
            expect(recording.messageObservations.filter(({ matrixId }) => matrixId === scenario.matrixId).map(({ agentId }) => agentId)).toEqual(
                scenario.expectedAgentIds
            );
        }
    });
});

class RecordingLiveRtcControl implements LiveRtcControlPort {
    readonly commands: LiveRtcControlClient.ExecuteInput[] = [];
    readonly milestones: string[] = [];
    readonly connected = new Set<string>();
    readonly nacks: ALNackPayload[] = [];
    readonly messageObservations: LiveRtcControlClient.WaitForMessageInput[] = [];
    readonly agents: readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent] = [
        this.createAgent('A'),
        this.createAgent('B'),
        this.createAgent('C')
    ];
    private createAgent(prefix: 'A' | 'B' | 'C'): LiveRtcControlClient.Agent {
        return {
            prefix,
            agentId: prefix,
            actor: prefix,
            connection: prefix,
            context: {} as BrowserContext,
            page: {
                evaluate: async (_callback: Parameters<Page['evaluate']>[0], input?: string) => {
                    if (typeof input === 'string') {
                        return this.nacks;
                    }
                    this.milestones.push(`refresh:${prefix}`);
                }
            } as Page
        };
    }
    executeOk = async (input: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
        this.commands.push(input);
        const command = input.command as { kind: string; request?: { path: string; method: string; }; };
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
    private recordCommand(input: LiveRtcControlClient.ExecuteInput, command: { kind: string; request?: { path: string; method: string; }; }): RtcBaselineJson {
        if (command.kind === 'rtc.connect') {
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
        else if (command.request?.path.endsWith('/topology')) {
            this.milestones.push('planned');
            return { snapshot: { activeSessionIds: [...this.connected].map((id) => `session-${id}`) } };
        }
        else if (command.request?.method === 'GET') {
            return { group: { lifecycleState: 'forming' } };
        }
        else if (command.request?.path.includes('/topology/config/')) {
            this.milestones.push('mesh');
        }
        else if (command.request?.path.includes('/lifecycle/establish/')) {
            this.milestones.push('establish');
        }
        else if (command.request?.path.includes('/lifecycle/activate/')) {
            this.milestones.push('activate');
        }
        return {};
    }
    resultValue(result: LiveRtcControlClient.Result): Record<string, RtcBaselineJson> {
        return result.result?.value as Record<string, RtcBaselineJson>;
    }
    requireSessionId(result: LiveRtcControlClient.Result): string {
        return `session-${result.agentId}`;
    }
    waitForPeerReadiness = async (input: LiveRtcControlClient.WaitForPeerReadinessInput): Promise<number> => {
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
