import {
    LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS,
    LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS,
    LIVE_RTC_PEER_READINESS_TIMEOUT_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-control-waits.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { LiveRtcControlPort } from '../../../tests/playwright/rallar-black-box/create-group-formation-lifecycle-driver.ts';
import {
    resolveLiveRtcResultWaitMs,
    type LiveRtcControlClient
} from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { normalizeJson } from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';

export namespace RecordingLiveRtcControl {
    export interface InitialState {
        readonly lifecycleState: 'forming' | 'active';
        readonly acceptedSessions: readonly string[];
        readonly rtcCapture?: ApiJsonValue;
    }
}

/**
 * A control port that answers a formation as a live group would. A test that counts the harness's bounded waits passes
 * `spendWait`, which each command, readiness, absence and message wait calls with the bound it waits.
 */
export class RecordingLiveRtcControl implements LiveRtcControlPort {
    readonly commands: LiveRtcControlClient.ExecuteInput[] = [];
    readonly milestones: string[] = [];
    readonly connected = new Set<string>();
    private lifecycleState: 'forming' | 'active' | 'connecting' | 'reconfiguring';
    private acceptedSessions: readonly string[];
    private readonly rtcCapture: ApiJsonValue | undefined;
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
    readonly agents: readonly [
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent,
        LiveRtcControlClient.FormationAgent
    ] = [this.createAgent('A'), this.createAgent('B'), this.createAgent('C')];
    private readonly spendWait: (waitMs: number) => Promise<void>;
    constructor(
        initial: RecordingLiveRtcControl.InitialState = {
            lifecycleState: 'forming',
            acceptedSessions: []
        },
        spendWait: (waitMs: number) => Promise<void> = async () => {}
    ) {
        this.spendWait = spendWait;
        this.lifecycleState = initial.lifecycleState;
        this.acceptedSessions = initial.acceptedSessions;
        this.rtcCapture = initial.rtcCapture;
    }

    deferReadinessObservations(): void {
        this.deferReadiness = true;
    }

    pendingReadinessCount(
        prefix: LiveRtcControlClient.FormationAgent['prefix']
    ): number {
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

    private createAgent(
        prefix: 'A' | 'B' | 'C'
    ): LiveRtcControlClient.FormationAgent {
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
    executeOk = async (
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result> => {
        this.commands.push(input);
        await this.spendWait(resolveLiveRtcResultWaitMs(input));
        const command = input.command;
        if (command.kind === 'formation.readiness') {
            return await this.recordFormationReadiness(input);
        }
        if (command.kind === 'rtc.send' && !this.connected.has(input.agentId)) {
            return { agentId: input.agentId, commandId: input.commandId, ok: false, error: { message: 'Runtime closed' } };
        }
        const body = this.recordCommand(input, command);
        const sessionId = this.sessionIdByAgentId.get(input.agentId);
        return {
            agentId: input.agentId,
            commandId: input.commandId,
            ok: true,
            result: {
                value: {
                    body,
                    ...(command.kind === 'rtc.connect' ? { almDiagnostics: true } : {}),
                    ...(command.kind === 'rtc.connect' && this.rtcCapture !== undefined ? { rtcCapture: normalizeJson(this.rtcCapture) } : {}),
                    ...(sessionId
                        ? {
                            sessionId,
                            message: {
                                message: {
                                    id: { msgId: 'attempted-message', senderId: sessionId }
                                }
                            }
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
        this.sessionIdByAgentId.set(
            agentId,
            `session-${agentId}-${connectionCount}`
        );
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
    resultValue(
        result: LiveRtcControlClient.Result
    ): ReturnType<LiveRtcControlPort['resultValue']> {
        const value = result.result?.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Recorded control result must contain an object value');
        }
        return value;
    }
    requireSessionId(result: LiveRtcControlClient.Result): string {
        const value = result.result?.value;
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            typeof value.sessionId === 'string'
        ) {
            return value.sessionId;
        }
        throw new Error('Recorded connect result must contain a session ID');
    }
    waitForPeerReadiness = async (
        input: LiveRtcControlClient.WaitForRtcReadinessInput
    ): Promise<number> => {
        await this.spendWait(LIVE_RTC_PEER_READINESS_TIMEOUT_MS);
        await input.agent.refreshRoom({ refresh: 'always', timeoutMs: LIVE_RTC_PEER_READINESS_TIMEOUT_MS });
        const dialableSessions = this.acceptedSessions.length > 0
            ? this.acceptedSessions
            : [...this.connected].map((id) => this.requireConnectedSessionId(id));
        if (input.expectedPeerIds.some((id) => !dialableSessions.includes(id))) {
            throw new Error(
                'Readiness requested for a peer absent from the dialable layout'
            );
        }
        return await this.recordReadiness(
            input.agent.prefix,
            input.expectedPeerIds
        );
    };

    private async recordFormationReadiness(
        input: LiveRtcControlClient.ExecuteInput
    ): Promise<LiveRtcControlClient.Result> {
        const prefix = input.agentId as LiveRtcControlClient.FormationAgent['prefix'];
        const ownSessionId = this.requireConnectedSessionId(input.agentId);
        const desiredPeerIds = this.acceptedSessions.filter(
            (sessionId) => sessionId !== ownSessionId
        );
        await this.recordReadiness(prefix, desiredPeerIds);
        return {
            agentId: input.agentId,
            commandId: input.commandId,
            ok: true,
            result: {
                value: {
                    readyAtEpochMs: Date.now(),
                    formation: {
                        stage: 'active',
                        room: {
                            state: 'open',
                            desiredPeerIds,
                            activePeerIds: desiredPeerIds,
                            readyPeerIds: desiredPeerIds,
                            failedPeerIds: [],
                            acceptedLayoutIdentity: {
                                groupRevision: this.groupRevision,
                                presenceRevision: this.connected.size,
                                version: 1,
                                state: 'active'
                            }
                        }
                    }
                }
            }
        };
    }

    private async recordReadiness(
        prefix: LiveRtcControlClient.FormationAgent['prefix'],
        expectedPeerIds: readonly string[]
    ): Promise<number> {
        this.readinessObservations.push({
            agentPrefix: prefix,
            expectedPeerIds
        });
        this.milestones.push(`ready:${prefix}`);
        this.milestones.push(`ready-start:${prefix}`);
        if (!this.deferReadiness) {
            this.milestones.push(`ready-complete:${prefix}`);
            return 1;
        }
        return await new Promise<number>((resolve) => {
            const pending = this.pendingReadiness.get(prefix) ?? [];
            pending.push((durationMs) => {
                this.milestones.push(`ready-complete:${prefix}`);
                resolve(durationMs);
            });
            this.pendingReadiness.set(prefix, pending);
        });
    }
    waitForPeerAbsence = async (
        input: LiveRtcControlClient.WaitForPeerAbsenceInput
    ): Promise<void> => {
        await this.spendWait(LIVE_RTC_PEER_ABSENCE_TIMEOUT_MS);
        this.milestones.push(
            `absent:${input.agent.prefix}:${input.departedPeerIds.join(',')}`
        );
    };
    waitForMessage = async (
        input: LiveRtcControlClient.WaitForMessageInput
    ): Promise<number> => {
        await this.spendWait(input.timeoutMs ?? LIVE_RTC_MESSAGE_WAIT_TIMEOUT_MS);
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
