import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeSendResult, RallarRtcSendInput } from '@shared-web/browser/rallar.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarMessagesRtcSendDiagnostics,
    BlackBoxRallarRealtimeSendDiagnostics,
    BlackBoxRallarSendDiagnostics,
    BlackBoxRallarSendInput
} from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf, blackBoxRallarScopeDiagnosticsOf } from '../black-box-rallar-operation-policy.ts';
import type {
    BlackBoxBrowserMessagesDependency,
    BlackBoxBrowserRealtimeDependency
} from '../browser-rallar-runtime-composition.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTopicId,
    resolveBlackBoxRallarTransport,
    resolveBlackBoxRallarTypeId
} from '../connection/black-box-rallar-connection-policy.ts';
import type { BlackBoxRallarHealthReader } from '../connection/black-box-rallar-health-reader.ts';
import { requireBlackBoxRallarInput } from '../decode-black-box-rallar-command-input.ts';
import { toDeliveryObservation } from './black-box-rallar-delivery-ledger.ts';
import type {
    BlackBoxRallarMessagingLease,
    BlackBoxRallarMessagingResourceController
} from './create-black-box-rallar-messaging-resource-controller.ts';
import { decodeBlackBoxRallarSendInput, type BlackBoxRallarSendCommand } from './decode-black-box-rallar-send-input.ts';

export namespace BlackBoxRallarRtcSendController {
    export interface Input {
        readonly messages: BlackBoxBrowserMessagesDependency;
        readonly realtime: BlackBoxBrowserRealtimeDependency;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly health: BlackBoxRallarHealthReader;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }
}

interface RealtimeSendTarget {
    readonly config: BlackBoxRallarConnectionConfig;
    readonly transport: BlackBoxRallarRealtimeSendDiagnostics['transport'];
    readonly lease: BlackBoxRallarMessagingLease;
}

interface RealtimeSendSummary {
    readonly total: number;
    readonly statuses: Readonly<Record<string, number>>;
    readonly peerIds: readonly string[];
    readonly attentionResults: readonly RallarRealtimeSendResult[];
}

const LATE_SEND_MESSAGE = 'Rallar send completed after the runtime closed.';

/** Owns rtc.send for both the realtime lane and typed messages.rtc, chosen by the transport of the connection. */
export class BlackBoxRallarRtcSendController {
    readonly #input: BlackBoxRallarRtcSendController.Input;

    constructor(input: BlackBoxRallarRtcSendController.Input) {
        this.#input = input;
    }

    /** A send whose fields do not decode fails like a transport failure, with its send_failed diagnostic. */
    send = async (command: BlackBoxRallarSendCommand): Promise<BlackBoxRallarSendDiagnostics> => {
        const config = this.#input.requireConfig();
        const lease = this.#input.resources.lease();
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const transport = resolveBlackBoxRallarTransport(config);
        try {
            return transport === 'messages.rtc'
                ? await this.#sendMessagesRtc(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarSendInput(command, 'messages.rtc')),
                    config,
                    lease
                )
                : await this.#sendRealtime(
                    requireBlackBoxRallarInput(decodeBlackBoxRallarSendInput(command, 'realtime')),
                    { config, transport, lease }
                );
        }
        catch (caught) {
            const error = toError(caught);
            this.#input.diagnostics.emitError({
                config,
                topic: `rallar.browser.${transport}.send_failed`,
                error,
                data: { transport }
            });
            throw error;
        }
    };

    async #sendRealtime(
        normalized: BlackBoxRallarSendInput,
        target: RealtimeSendTarget
    ): Promise<BlackBoxRallarRealtimeSendDiagnostics> {
        const { config, transport, lease } = target;
        const peerIds = resolveRealtimePeerIds(normalized, config) ??
            this.#input.health.getRtcStatus(config).readyPeerIds;
        const laneId = normalized.laneId ?? resolveBlackBoxRallarLaneId(config);
        const roomId = normalized.roomId ?? config.roomId;
        const roomRef = blackBoxRallarRoomRefOf(config, normalized);
        const scopeDiagnostics = blackBoxRallarScopeDiagnosticsOf(config, normalized);
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_started', {
            roomId,
            roomRef,
            ...scopeDiagnostics,
            laneId,
            peerIds
        });
        const results = await this.#input.realtime.sendJson({
            data: normalized.data !== undefined ? normalized.data : normalized.payload,
            laneId,
            roomId,
            roomRef,
            peerIds,
            openTimeoutMs: normalized.openTimeoutMs ?? config.rallar.openTimeoutMs,
            key: normalized.key,
            maxAgeMs: normalized.maxAgeMs
        });
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const diagnostics: BlackBoxRallarRealtimeSendDiagnostics = {
            status: results.length === 0 ? 'no-peers' : 'sent',
            connection: config.connection,
            actor: config.actor,
            transport,
            roomId,
            ...scopeDiagnostics,
            laneId,
            peerIds,
            results,
            health: this.#input.health.getLaneHealth(config)
        };
        this.#emitRealtimeSendOutcome(config, diagnostics);
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_completed', diagnostics);
        return diagnostics;
    }

    #emitRealtimeSendOutcome(
        config: BlackBoxRallarConnectionConfig,
        diagnostics: BlackBoxRallarRealtimeSendDiagnostics
    ): void {
        const summary = computeRealtimeSendSummary(diagnostics.results);
        const data = {
            roomId: diagnostics.roomId,
            laneId: diagnostics.laneId,
            peerIds: diagnostics.peerIds,
            health: diagnostics.health,
            summary
        };
        const statuses = summary.statuses;
        if (diagnostics.results.length === 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.peer_not_found', data);
        }
        if ((statuses.closed ?? 0) > 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.data_channel_not_open', data);
        }
        const attention = (statuses.queued ?? 0) + (statuses.dropped ?? 0) + (statuses.replaced ?? 0) +
            (statuses.closed ?? 0);
        if (attention > 0) {
            this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.realtime.send_result_attention', data);
        }
    }

    async #sendMessagesRtc(
        normalized: BlackBoxRallarSendInput,
        config: BlackBoxRallarConnectionConfig,
        lease: BlackBoxRallarMessagingLease
    ): Promise<BlackBoxRallarMessagesRtcSendDiagnostics> {
        const request = toRtcSendRequest(normalized, config);
        const context = {
            roomId: request.roomId,
            roomRef: request.roomRef,
            typeId: request.typeId,
            topicId: request.topicId,
            contextId: request.contextId,
            resourceId: request.resourceId,
            minSnapshotVersion: request.minSnapshotVersion,
            ...blackBoxRallarScopeDiagnosticsOf(config, normalized),
            nextHopPeerIds: request.nextHopPeerIds
        };
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_started', context);
        const handle = await this.#input.messages.rtc.send(request);
        this.#input.resources.assertCurrent(lease, LATE_SEND_MESSAGE);
        const diagnostics: BlackBoxRallarMessagesRtcSendDiagnostics = {
            connection: config.connection,
            actor: config.actor,
            transport: 'messages.rtc',
            ...context,
            message: toDeliveryObservation(handle.msgId, handle.lifecycle()),
            health: this.#input.health.getLaneHealth(config)
        };
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.rtc.send_completed', diagnostics);
        return diagnostics;
    }
}

function toRtcSendRequest(
    input: BlackBoxRallarSendInput,
    config: BlackBoxRallarConnectionConfig
): RallarRtcSendInput<RallarMessagePayload | undefined> {
    const defaults = config.rallar;
    return {
        typeId: input.typeId ?? resolveBlackBoxRallarTypeId(config),
        topicId: input.topicId ?? resolveBlackBoxRallarTopicId(config),
        roomId: input.roomId ?? config.roomId,
        roomRef: blackBoxRallarRoomRefOf(config, input),
        contextId: input.contextId ?? defaults.contextId,
        resourceId: input.resourceId ?? defaults.resourceId,
        minSnapshotVersion: input.minSnapshotVersion ?? defaults.minSnapshotVersion,
        nextHopPeerIds: input.nextHopPeerIds ?? input.peerIds ?? defaults.nextHopPeerIds ?? defaults.peerIds,
        payload: 'payload' in input ? input.payload : input.data,
        ttlHops: input.ttlHops ?? defaults.ttlHops,
        ttlMs: input.ttlMs ?? defaults.ttlMs,
        reliability: input.reliability ?? defaults.reliability,
        ack: input.ack ?? defaults.ack,
        ownership: input.ownership ?? defaults.ownership,
        membershipEpoch: input.membershipEpoch ?? defaults.membershipEpoch,
        seq: input.seq ?? defaults.seq,
        orderingKey: input.orderingKey ?? defaults.orderingKey,
        overlayId: input.overlayId ?? defaults.overlayId,
        fanoutLimit: input.fanoutLimit ?? defaults.fanoutLimit
    };
}

/** Undefined when neither the send nor the connection names a peer, so the lane falls back to its ready peers. */
function resolveRealtimePeerIds(
    input: BlackBoxRallarSendInput,
    config: BlackBoxRallarConnectionConfig
): readonly string[] | undefined {
    if (input.peerIds) {
        return input.peerIds;
    }
    if (input.remotePeerId) {
        return [input.remotePeerId];
    }
    return config.remotePeerId ? [config.remotePeerId] : config.rallar.peerIds;
}

function computeRealtimeSendSummary(results: readonly RallarRealtimeSendResult[]): RealtimeSendSummary {
    const statuses: Record<string, number> = {};
    for (const entry of results) {
        statuses[entry.result.status] = (statuses[entry.result.status] ?? 0) + 1;
    }
    return {
        total: results.length,
        statuses,
        peerIds: results.map((entry) => entry.peerId),
        attentionResults: results.filter((entry) => entry.result.status !== 'sent')
    };
}
