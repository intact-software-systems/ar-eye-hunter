import {
    computeALStorageAvailability,
    type BrowserALStorageAvailability
} from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALAckAlgo, ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryCarrier,
    ALDeliveryDurabilityDowngrade,
    ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    isALDeliveryAdmissionFallbackVerdict,
    isALDeliveryFallbackPastDeadline
} from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALStorageUnavailable } from '@shared/alm/storage/al-storage-unavailable.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';
import type { BrowserSessionDeliveries } from './browser-session-deliveries.ts';
import type { RallarStorageUnavailablePolicy } from './rallar-message-contracts.ts';

/** What the strategy does after one carrier leg: hand the send to the fallback carrier, stop, or expire it. */
export type BrowserFallbackDisposition = 'retry' | 'stop' | 'expired';

interface CapturedMessageAdmission {
    readonly message: ALMessage;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly trackedReceiptAlgo: ALAckAlgo;
    readonly durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined;
}

/** The verdict of one carrier leg and what the strategy does next with it. */
interface CarrierAdmission {
    readonly msgId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly trackedReceiptAlgo: ALAckAlgo;
    readonly fallback: BrowserFallbackDisposition;
}

export namespace BrowserRallarMessageDispatch {
    export interface Delivery {
        readonly context: ApiMiddleware;
        readonly carrier: ALDeliveryCarrier;
        readonly message: ALMessage;
        readonly canFallback: boolean;
        readonly payloadIssues: readonly RallarValidationIssue[];
        readonly onStorageUnavailable: RallarStorageUnavailablePolicy;
    }

    export interface Input {
        readonly deliveries: BrowserRallarDeliveryRegistry;
        readonly sessionDeliveries: BrowserSessionDeliveries;
        readonly nowMs: () => number;
    }
}

/** Owns admission and carrier fallback after the sender opens the caller's handle. */
export class BrowserRallarMessageDispatch {
    private readonly input: BrowserRallarMessageDispatch.Input;

    constructor(input: BrowserRallarMessageDispatch.Input) {
        this.input = input;
    }

    send(delivery: BrowserRallarMessageDispatch.Delivery): void {
        const epoch = this.input.sessionDeliveries.capture(delivery.context);
        if (!epoch) {
            this.input.deliveries.release(delivery.message.id.msgId);
            return;
        }
        void this.writeLeg(delivery, epoch);
    }

    /** One carrier leg, whose failure is stated as its admission and never thrown. */
    private async writeLeg(
        delivery: BrowserRallarMessageDispatch.Delivery,
        lifetime: BrowserDeliverySettlements.Epoch
    ): Promise<void> {
        await this.writeCapturedMessage(delivery, lifetime).catch((caught) => {
            if (lifetime.isOpen()) {
                lifetime.settlements[delivery.carrier]({
                    kind: 'admission',
                    msgId: delivery.message.id.msgId,
                    carrier: delivery.carrier,
                    atMs: this.input.nowMs(),
                    verdict: { kind: 'failed', detail: toError(caught).message },
                    trackedReceiptAlgo: 'none'
                });
            }
        });
    }

    private async writeCapturedMessage(
        delivery: BrowserRallarMessageDispatch.Delivery,
        lifetime: BrowserDeliverySettlements.Epoch
    ): Promise<void> {
        if (!lifetime.isOpen()) {
            return;
        }
        const result = await this.admitCapturedMessage(delivery);
        if (!lifetime.isOpen()) {
            return;
        }
        this.input.deliveries.updateDeadline(result.message);
        const sink = lifetime.settlements[delivery.carrier];
        const admission = this.toCarrierAdmission(delivery, result);
        this.watchFallbackLeg(delivery, result, lifetime);
        if (result.durabilityDowngrade !== undefined) {
            sink(toDurabilityDowngradeSettlement(admission, result.durabilityDowngrade, this.input.nowMs()));
        }
        sink(toCarrierAdmissionSettlement(admission, this.input.nowMs()));
        wakeQueueBoxEngineIfQueued(delivery.context.middleware.qboxEngine, result);
        if (admission.fallback === 'retry') {
            await this.writeCapturedMessage({
                ...delivery,
                carrier: delivery.carrier === 'rtc' ? 'ws' : 'rtc',
                message: result.message,
                canFallback: false
            }, lifetime);
            return;
        }
        const end = toCarrierAdmissionEndSettlement(admission, this.input.nowMs());
        if (end) {
            sink(end);
        }
    }

    private toCarrierAdmission(
        delivery: BrowserRallarMessageDispatch.Delivery,
        result: CapturedMessageAdmission
    ): CarrierAdmission {
        return {
            msgId: delivery.message.id.msgId,
            carrier: delivery.carrier,
            verdict: result.verdict,
            trackedReceiptAlgo: result.trackedReceiptAlgo,
            fallback: delivery.canFallback
                ? computeFallbackDisposition(
                    result.verdict,
                    result.message.constraints?.expiresAtMs,
                    this.input.nowMs()
                )
                : 'stop'
        };
    }

    /** An admitted RTC leg of `rtc-with-ws-fallback` may still hand over after admission (D56); `ws-then-rtc` does not (Q1). */
    private watchFallbackLeg(
        delivery: BrowserRallarMessageDispatch.Delivery,
        result: CapturedMessageAdmission,
        lifetime: BrowserDeliverySettlements.Epoch
    ): void {
        if (!delivery.canFallback || delivery.carrier !== 'rtc' || !isCarrierOwnedVerdict(result.verdict)) {
            return;
        }
        const wsLeg: BrowserRallarMessageDispatch.Delivery = {
            ...delivery,
            carrier: 'ws',
            message: result.message,
            canFallback: false
        };
        this.input.deliveries.watchFallback({
            message: result.message,
            context: delivery.context,
            readmit: () => this.writeLeg(wsLeg, lifetime)
        });
    }

    private async admitCapturedMessage(
        delivery: BrowserRallarMessageDispatch.Delivery
    ): Promise<CapturedMessageAdmission> {
        const { message } = delivery;
        const validated = decodeALMessageValue(message);
        const issue = delivery.payloadIssues[0];
        if (issue) {
            return toUnadmittedAdmission(message, { kind: 'refused', reason: 'oversized', detail: issue.message });
        }
        if (validated.left) {
            return toUnadmittedAdmission(message, {
                kind: 'refused',
                reason: validated.left.code,
                detail: validated.left.message
            });
        }
        if (message.constraints?.expiresAtMs !== undefined && message.constraints.expiresAtMs <= this.input.nowMs()) {
            return toUnadmittedAdmission(message, {
                kind: 'expired',
                detail: 'Message deadline elapsed before carrier admission.'
            });
        }
        try {
            return await writeChannelAdmission(delivery);
        }
        catch (caught) {
            return toUnadmittedAdmission(message, { kind: 'failed', detail: toError(caught).message });
        }
    }
}

function toUnadmittedAdmission(message: ALMessage, verdict: ALDeliveryAdmissionVerdict): CapturedMessageAdmission {
    return { message, verdict, trackedReceiptAlgo: 'none', durabilityDowngrade: undefined };
}

/** Admitting the same msgId again is sound because a `storage-unavailable` admission committed nothing. */
async function writeChannelAdmission(
    delivery: BrowserRallarMessageDispatch.Delivery
): Promise<CapturedMessageAdmission> {
    const admitted = await writeStorageAdmission(delivery);
    if (admitted.verdict.kind !== 'storage-unavailable' || delivery.onStorageUnavailable === 'refuse') {
        return toCapturedAdmission(admitted, undefined);
    }
    const downgrade: ALDeliveryDurabilityDowngrade = {
        requested: toRequestedDurability(delivery.message),
        cause: admitted.verdict.cause
    };
    return toCapturedAdmission(
        await writeCarrierOutboxAdmission(delivery.context, delivery, toVolatileALMessage(delivery.message)),
        downgrade
    );
}

/**
 * A durable or checkpoint message skips the carrier while storage is missing for the document, and a
 * checkpoint message also while a checkpoint store lags beyond its bound; any durable admission that
 * reaches the carrier re-decides the connect's availability.
 */
async function writeStorageAdmission(
    delivery: BrowserRallarMessageDispatch.Delivery
): Promise<ALOutboundEnqueueResult> {
    const storage = delivery.context.middleware.storageAvailability;
    const durability = toRequestedDurability(delivery.message);
    const skipped = resolveStorageLaneSkip(storage, durability);
    if (skipped !== undefined) {
        const verdict: ALDeliveryAdmissionVerdict = { kind: 'storage-unavailable', ...skipped };
        return { verdict, message: delivery.message, entries: [], trackedReceiptAlgo: 'none' };
    }
    const admitted = await writeCarrierOutboxAdmission(delivery.context, delivery, delivery.message);
    recordStorageVerdict(storage, admitted.verdict, durability);
    return admitted;
}

function resolveStorageLaneSkip(
    storage: BrowserALStorageAvailability,
    durability: ALDurabilityAlgo
): ALStorageUnavailable | undefined {
    switch (durability) {
        case 'volatile':
            return undefined;
        case 'local-checkpoint':
            return storage.getCheckpointLaneSkip();
        case 'local-outbox':
        case 'local-inbox':
            return storage.getDurableLaneSkip();
    }
}

/** A checkpoint admission writes memory only, so it says nothing of IndexedDB; the owner's checkpoint still wants persistence. */
function recordStorageVerdict(
    storage: BrowserALStorageAvailability,
    verdict: ALDeliveryAdmissionVerdict,
    durability: ALDurabilityAlgo
): void {
    if (durability !== 'local-checkpoint') {
        storage.availability.accept(computeALStorageAvailability(storage.availability.get(), verdict));
    }
    if (verdict.kind === 'admitted' && (verdict.durable || durability === 'local-checkpoint')) {
        storage.requestPersistentStorage();
    }
}

function toCapturedAdmission(
    result: ALOutboundEnqueueResult,
    durabilityDowngrade: ALDeliveryDurabilityDowngrade | undefined
): CapturedMessageAdmission {
    return {
        message: result.message,
        verdict: result.verdict,
        trackedReceiptAlgo: result.trackedReceiptAlgo,
        durabilityDowngrade
    };
}

function toRequestedDurability(message: ALMessage): ALDurabilityAlgo {
    return message.qos?.durability?.algo ?? 'volatile';
}

function toVolatileALMessage(message: ALMessage): ALMessage {
    return { ...message, qos: { ...message.qos, durability: { algo: 'volatile' } } };
}

/** The carrier owns the message now: admitted, already held, or retained for its own replay. */
function isCarrierOwnedVerdict(verdict: ALDeliveryAdmissionVerdict): boolean {
    return verdict.kind === 'admitted' || verdict.kind === 'duplicate' ||
        verdict.kind === 'pending';
}

export interface CarrierOutboxLeg {
    readonly carrier: ALDeliveryCarrier;
    readonly canFallback: boolean;
}

/** One carrier's own outbound admission of an envelope: the call a first send and its fallback both make. */
export async function writeCarrierOutboxAdmission(
    context: ApiMiddleware,
    leg: CarrierOutboxLeg,
    message: ALMessage
): Promise<ALOutboundEnqueueResult> {
    return leg.carrier === 'rtc'
        ? await context.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(
            message,
            leg.canFallback ? 'hand-over' : 'hold'
        )
        : await context.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
}

/** A verdict the declared list hands to the fallback carrier at admission (D42, D56), inside the deadline. */
export function computeFallbackDisposition(
    verdict: ALDeliveryAdmissionVerdict,
    expiresAtMs: number | undefined,
    nowMs: number
): BrowserFallbackDisposition {
    if (!isALDeliveryAdmissionFallbackVerdict(verdict)) {
        return 'stop';
    }
    return isALDeliveryFallbackPastDeadline(expiresAtMs, nowMs) ? 'expired' : 'retry';
}

/** A refusal the fallback carrier takes over is evidence of the refused leg, not the verdict: `rejected` is terminal. */
function toCarrierAdmissionSettlement(admission: CarrierAdmission, atMs: number): ALDeliverySettlement {
    const { msgId, carrier, verdict, trackedReceiptAlgo } = admission;
    return admission.fallback !== 'stop' && verdict.kind === 'refused'
        ? { kind: 'carrier-refused', msgId, carrier, atMs, reason: verdict.reason, detail: verdict.detail }
        : { kind: 'admission', msgId, carrier, atMs, verdict, trackedReceiptAlgo };
}

function toDurabilityDowngradeSettlement(
    admission: CarrierAdmission,
    downgrade: ALDeliveryDurabilityDowngrade,
    atMs: number
): ALDeliverySettlement {
    return {
        kind: 'durability-downgrade',
        msgId: admission.msgId,
        carrier: admission.carrier,
        atMs,
        ...downgrade
    };
}

/** What ends a leg no fallback continues: the deadline it reached first, or no carrier left to route it. */
function toCarrierAdmissionEndSettlement(
    admission: CarrierAdmission,
    atMs: number
): ALDeliverySettlement | undefined {
    const { msgId, carrier, verdict } = admission;
    if (admission.fallback === 'expired') {
        return { kind: 'expired', msgId, carrier, atMs, detail: 'Message deadline elapsed before fallback.' };
    }
    return verdict.kind === 'unroutable'
        ? {
            kind: 'attempts-exhausted',
            msgId,
            carrier,
            atMs,
            reason: verdict.reason,
            detail: verdict.detail
        }
        : undefined;
}

export function wakeQueueBoxEngineIfQueued(
    engine: ApiMiddleware['middleware']['qboxEngine'],
    result: Pick<ALOutboundEnqueueResult, 'verdict'>
): void {
    if (result.verdict.kind === 'admitted' || result.verdict.kind === 'duplicate') {
        engine.wake();
    }
}
