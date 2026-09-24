import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageHandle, RallarTypedMessageSendOptions } from '@shared-web/browser/rallar.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryLifecycle,
    type ALDeliveryUnroutableReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarDeliveryHandleInput,
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarDeliveryObserveInput,
    BlackBoxRallarMessageReplayDiagnostics,
    BlackBoxRallarMessageReplayInput,
    BlackBoxRallarMessageReplayTarget,
    BlackBoxRallarMessageSendDiagnostics,
    BlackBoxRallarMessageSendInput
} from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxBrowserDeliveriesDependency } from '../browser-rallar-runtime-composition.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from './black-box-rallar-delivery-error-message-prefixes.ts';
import type { BlackBoxRallarTypedChannels } from './black-box-rallar-typed-channels.ts';
import type { BlackBoxRallarMessagingResourceController } from './create-black-box-rallar-messaging-resource-controller.ts';

export namespace BlackBoxRallarDeliveryLedger {
    export interface Input {
        readonly deliveries: BlackBoxBrowserDeliveriesDependency;
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }
}

const BACKPRESSURE_ADMISSION_REASONS: readonly ALDeliveryUnroutableReason[] = ['rate-limited', 'circuit-open'];

/** A handle the registry never held or has evicted reads with no evidence, as if this page never sent it. */
export function toDeliveryObservation(
    handleId: string,
    lifecycle: ALDeliveryLifecycle | undefined
): BlackBoxRallarDeliveryObservation {
    const attempts = lifecycle?.evidence.attempts ?? [];
    return {
        handleId,
        state: lifecycle?.state ?? 'unobservable',
        submitted: attempts.some((attempt) => attempt.submissionAttempted),
        confirmedHopPeerIds: lifecycle?.evidence.confirmedHopPeerIds ?? [],
        unconfirmedHopPeerIds: lifecycle?.evidence.unconfirmedHopPeerIds ?? [],
        attempts: attempts.length,
        reason: lifecycle?.evidence.reason,
        backpressured: attempts.some((attempt) =>
            attempt.unroutableReason !== undefined && BACKPRESSURE_ADMISSION_REASONS.includes(attempt.unroutableReason)
        ),
        enqueued: lifecycle?.evidence.admittedDurable === true
    };
}

export class BlackBoxRallarDeliveryLedger {
    readonly #input: BlackBoxRallarDeliveryLedger.Input;
    /** handleId to msgId only: the session registry alone decides how long a handle stays observable. */
    readonly #deliveryMsgIds = new Map<string, string>();

    constructor(input: BlackBoxRallarDeliveryLedger.Input) {
        this.#input = input;
    }

    sendMessage = async (
        send: BlackBoxRallarMessageSendInput | BlackBoxRallarMessageReplayInput
    ): Promise<BlackBoxRallarMessageSendDiagnostics | BlackBoxRallarMessageReplayDiagnostics> =>
        'replayOnCarrier' in send
            ? await this.#replayMessage(send.replayOnCarrier)
            : await this.#sendNewMessage(send);

    async #sendNewMessage(send: BlackBoxRallarMessageSendInput): Promise<BlackBoxRallarMessageSendDiagnostics> {
        const config = this.#input.requireConfig();
        const lease = this.#input.resources.lease();
        this.#input.resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const roomRef = blackBoxRallarRoomRefOf(config, { roomRef: send.roomRef });
        const channel = this.#input.typedChannels.open(config, { typeId: send.typeId, topicId: send.topicId, roomRef });
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.send_started', {
            handleId: send.handleId,
            carrier: send.carrier,
            typeId: send.typeId,
            topicId: send.topicId,
            roomId: config.roomId,
            roomRef
        });
        const handle = await channel.send(send.payload, toTypedSendOptions(send));
        this.#deliveryMsgIds.set(send.handleId, handle.msgId);
        this.#dropEvictedDeliveries();
        const outcome = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: send.timeoutMs });
        this.#input.resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const diagnostics: BlackBoxRallarMessageSendDiagnostics = {
            handleId: send.handleId,
            msgId: handle.msgId,
            carrier: send.carrier,
            status: outcome.lifecycle.state,
            reason: outcome.lifecycle.evidence.reason
        };
        this.#input.diagnostics.emitDiagnostic(config, 'rallar.browser.messages.send_completed', diagnostics);
        return diagnostics;
    }

    /** Re-admits the envelope an earlier send captured; the replay opens no handle of its own. */
    async #replayMessage(replay: BlackBoxRallarMessageReplayTarget): Promise<BlackBoxRallarMessageReplayDiagnostics> {
        const lease = this.#input.resources.lease();
        const msgId = this.#deliveryMsgIds.get(replay.handleId);
        if (msgId === undefined) {
            throw new TypeError(`messages.send.replayOnCarrier names no retained handle ${replay.handleId}.`);
        }
        const verdict = await this.#input.deliveries.replayCapturedMessage({ msgId, carrier: replay.carrier });
        this.#input.resources.assertCurrent(lease, 'Rallar replay completed after the runtime closed.');
        return {
            handleId: replay.handleId,
            msgId,
            carrier: replay.carrier,
            verdict: verdict.kind,
            reason: 'detail' in verdict ? verdict.detail : undefined
        };
    }

    readReceipts = async (
        { handleId }: BlackBoxRallarDeliveryHandleInput
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        return toDeliveryObservation(handleId, this.#getDeliveryHandle(handleId)?.lifecycle());
    };

    observeDelivery = async (
        observe: BlackBoxRallarDeliveryObserveInput
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        const handle = this.#getDeliveryHandle(observe.handleId);
        if (!handle) {
            return toDeliveryObservation(observe.handleId, undefined);
        }
        const outcome = await handle.wait({ until: observe.state, timeoutMs: observe.timeoutMs });
        if (outcome.status === 'timeout') {
            throw new TypeError(
                `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.deliveryStateTimeout} ` +
                    `${observe.handleId} did not reach [${observe.state.join(', ')}]; ` +
                    `last state ${outcome.lifecycle.state}`
            );
        }
        const retained = this.#getDeliveryHandle(observe.handleId) !== undefined;
        return toDeliveryObservation(observe.handleId, retained ? outcome.lifecycle : undefined);
    };

    cancelDelivery = async (
        { handleId }: BlackBoxRallarDeliveryHandleInput
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        const handle = this.#getDeliveryHandle(handleId);
        handle?.cancel();
        return toDeliveryObservation(handleId, handle?.lifecycle());
    };

    #getDeliveryHandle(handleId: string): RallarMessageHandle | undefined {
        const msgId = this.#deliveryMsgIds.get(handleId);
        return msgId === undefined ? undefined : this.#input.deliveries.getHandle(msgId);
    }

    #dropEvictedDeliveries(): void {
        for (const [handleId, msgId] of this.#deliveryMsgIds) {
            if (this.#input.deliveries.getHandle(msgId) === undefined) {
                this.#deliveryMsgIds.delete(handleId);
            }
        }
    }
}

function toTypedSendOptions(send: BlackBoxRallarMessageSendInput): RallarTypedMessageSendOptions<RallarMessagePayload> {
    return {
        strategy: send.carrier,
        ...(send.reliability === undefined ? {} : { reliability: send.reliability }),
        ...(send.ack === undefined ? {} : { ack: send.ack }),
        ...(send.ttlMs === undefined ? {} : { ttlMs: send.ttlMs }),
        ...(send.orderingKey === undefined ? {} : { orderingKey: send.orderingKey }),
        ...(send.seq === undefined ? {} : { seq: send.seq }),
        ...(send.scope === undefined ? {} : { scope: send.scope })
    };
}
