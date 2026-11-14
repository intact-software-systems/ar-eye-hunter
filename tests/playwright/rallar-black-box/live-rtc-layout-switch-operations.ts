import { RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS } from '@shared-test/rallar-bb-test/rtc-stream.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { jsonRecord, numberValue } from './live-rtc-evidence-json.ts';
import type { FormationHealth, LiveRtcFormationOperations } from './live-rtc-formation-operations.ts';
import { LIVE_RTC_LAYOUT_SWITCH_FRAME_TOPIC } from './live-rtc-layout-switch-evidence.ts';

export type LiveRtcStreamReliability = 'at-least-once' | 'best-effort';

export namespace LiveRtcLayoutSwitchOperations {
    export interface Input {
        readonly control: LiveRtcControlClient;
        readonly formation: LiveRtcFormationOperations;
        readonly runId: string;
        readonly roomRef: GroupRef;
        readonly suffix: string;
        readonly owner: LiveRtcControlClient.Agent;
        /** The typed channel every browser subscribed to at connect, so each one hears the others' frames. */
        readonly messagesRtc: Readonly<{ typeId: string; topicId: string; }>;
    }

    export interface StreamInput {
        readonly agent: LiveRtcControlClient.Agent;
        readonly reliability: LiveRtcStreamReliability;
        readonly rateHz: number;
        readonly durationMs: number;
    }
}

/**
 * The control commands the layout-switch spec issues beyond the formation driver: the owner's durable topology
 * writes, the configuration read, each browser's health, and one `rtc.stream` per browser.
 */
export class LiveRtcLayoutSwitchOperations {
    readonly #input: LiveRtcLayoutSwitchOperations.Input;
    #issuedCommandCount = 0;

    constructor(input: LiveRtcLayoutSwitchOperations.Input) {
        this.#input = input;
    }

    async readServedOverlapMs(): Promise<number | undefined> {
        const { control, runId, owner } = this.#input;
        const result = await control.executeOk({
            runId,
            agentId: owner.agentId,
            commandId: this.#createCommandId('api-config'),
            command: {
                kind: 'http.request',
                request: { path: '/api/config', method: 'GET' },
                response: { body: 'json', acceptedStatusCodes: [200] },
                timeoutMs: 10_000
            }
        });
        return numberValue(jsonRecord(control.resultValue(result).body)?.rtcReplacedLayoutOverlapMs);
    }

    /** The owner replaces the durable topology config; the instant is taken before the write is enqueued. */
    async writeTopologyKind(topologyKind: 'tree' | 'star'): Promise<number> {
        const { control, runId, owner, roomRef } = this.#input;
        const commandId = this.#createCommandId(`topology-${topologyKind}`);
        const requestedAtEpochMs = Date.now();
        await control.executeOk({
            runId,
            agentId: owner.agentId,
            commandId,
            command: {
                kind: 'http.request',
                request: {
                    path: `${toGroupPath(roomRef)}/topology/config/requests/${encodeURIComponent(commandId)}`,
                    method: 'PUT',
                    body: { config: { topologyKind } }
                },
                response: { body: 'json', acceptedStatusCodes: [200] },
                timeoutMs: 10_000
            }
        });
        return requestedAtEpochMs;
    }

    async readHealth(agent: LiveRtcControlClient.Agent): Promise<FormationHealth> {
        const { control, runId, roomRef, suffix } = this.#input;
        return await this.#input.formation.health({ control, runId, agent, roomRef, suffix });
    }

    /** The stream reports once its last frame settled, so the wait covers its duration and its own drain. */
    async runStream(input: LiveRtcLayoutSwitchOperations.StreamInput): Promise<LiveRtcControlClient.Result> {
        const { control, runId, roomRef, messagesRtc } = this.#input;
        const { agent, reliability } = input;
        return await control.executeResult({
            runId,
            agentId: agent.agentId,
            commandId: this.#createCommandId(`stream-${agent.prefix.toLowerCase()}`),
            command: {
                kind: 'rtc.stream',
                connection: `${agent.connection}-messages-rtc`,
                actor: agent.actor,
                transport: 'messages.rtc',
                roomId: roomRef.groupId,
                applicationId: roomRef.applicationId,
                workspaceId: roomRef.workspaceId,
                roomRef: { ...roomRef },
                rateHz: input.rateHz,
                durationMs: input.durationMs,
                continueOnSendFailure: true,
                send: {
                    roomId: roomRef.groupId,
                    typeId: messagesRtc.typeId,
                    topicId: messagesRtc.topicId,
                    reliability,
                    payload: {
                        topic: LIVE_RTC_LAYOUT_SWITCH_FRAME_TOPIC,
                        runId,
                        origin: agent.prefix,
                        seq: '{stream.iteration}'
                    }
                }
            },
            timeoutMs: input.durationMs + 2 * RALLAR_BLACK_BOX_RTC_STREAM_DEFAULT_DRAIN_TIMEOUT_MS
        });
    }

    #createCommandId(name: string): string {
        this.#issuedCommandCount += 1;
        return `layout-switch-${name}-${this.#input.suffix}-${this.#issuedCommandCount}`;
    }
}

function toGroupPath(roomRef: GroupRef): string {
    return `/api/state/apps/${encodeURIComponent(roomRef.applicationId)}/workspaces/${
        encodeURIComponent(roomRef.workspaceId)
    }/groups/${encodeURIComponent(roomRef.groupId)}`;
}
