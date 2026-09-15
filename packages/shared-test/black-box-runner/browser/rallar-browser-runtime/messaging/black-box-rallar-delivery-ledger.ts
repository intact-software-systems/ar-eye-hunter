import type { RallarMessageHandle } from '@shared-web/browser/rallar.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from '../black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarMessageSendDiagnostics
} from '../black-box-rallar-operation-contracts.ts';
import { blackBoxRallarRoomRefOf } from '../black-box-rallar-operation-policy.ts';
import type { BlackBoxRallarRuntime } from '../black-box-rallar-runtime-contract.ts';
import type { BlackBoxBrowserDeliveriesDependency } from '../browser-rallar-runtime-composition.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from './black-box-rallar-delivery-error-message-prefixes.ts';
import type { BlackBoxRallarTypedChannels } from './black-box-rallar-typed-channels.ts';
import type { BlackBoxRallarMessagingResourceController } from './create-black-box-rallar-messaging-resource-controller.ts';
import {
    decodeBlackBoxRallarDeliveryHandleInput,
    decodeBlackBoxRallarDeliveryObserveInput,
    decodeBlackBoxRallarMessageSendInput
} from './decode-black-box-rallar-messaging-input.ts';
import { toTypedSendOptions } from './to-black-box-rallar-send-requests.ts';

export namespace BlackBoxRallarDeliveryLedger {
    export interface Input {
        readonly deliveries: BlackBoxBrowserDeliveriesDependency;
        readonly typedChannels: BlackBoxRallarTypedChannels;
        readonly resources: BlackBoxRallarMessagingResourceController;
        readonly diagnostics: BlackBoxRallarRuntimeDiagnostics;
        requireConfig(): BlackBoxRallarConnectionConfig;
    }
}

/** A handle the registry never held or has evicted reads with no evidence, as if this page never sent it. */
export function toDeliveryObservation(
    handleId: string,
    lifecycle: ALDeliveryLifecycle | undefined
): BlackBoxRallarDeliveryObservation {
    return {
        handleId,
        state: lifecycle?.state ?? 'unobservable',
        submitted: lifecycle?.evidence.attempts.some((attempt) => attempt.submissionAttempted) ?? false,
        confirmedHopPeerIds: lifecycle?.evidence.confirmedHopPeerIds ?? [],
        unconfirmedHopPeerIds: lifecycle?.evidence.unconfirmedHopPeerIds ?? [],
        attempts: lifecycle?.evidence.attempts.length ?? 0,
        reason: lifecycle?.evidence.reason
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
        input: Parameters<BlackBoxRallarRuntime['sendMessage']>[0]
    ): Promise<BlackBoxRallarMessageSendDiagnostics> => {
        const config = this.#input.requireConfig();
        const lease = this.#input.resources.lease();
        this.#input.resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
        const send = decodeBlackBoxRallarMessageSendInput(input);
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
    };

    readReceipts = async (
        input: Parameters<BlackBoxRallarRuntime['readReceipts']>[0]
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        const { handleId } = decodeBlackBoxRallarDeliveryHandleInput(input);
        return toDeliveryObservation(handleId, this.#getDeliveryHandle(handleId)?.lifecycle());
    };

    observeDelivery = async (
        input: Parameters<BlackBoxRallarRuntime['observeDelivery']>[0]
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        const observe = decodeBlackBoxRallarDeliveryObserveInput(input);
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
        input: Parameters<BlackBoxRallarRuntime['cancelDelivery']>[0]
    ): Promise<BlackBoxRallarDeliveryObservation> => {
        const { handleId } = decodeBlackBoxRallarDeliveryHandleInput(input);
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
