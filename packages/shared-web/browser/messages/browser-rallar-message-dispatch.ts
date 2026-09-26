import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryCarrier,
    ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';
import type { BrowserSessionDeliveries } from './browser-session-deliveries.ts';

interface CapturedMessageAdmission {
    readonly message: ALMessage;
    readonly verdict: ALDeliveryAdmissionVerdict;
}

/** The verdict of one carrier leg and what the strategy does next with it. */
interface CarrierAdmission {
    readonly msgId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly fallback: ReturnType<typeof computeFallbackDisposition>;
}

export namespace BrowserRallarMessageDispatch {
    export interface Delivery {
        readonly context: ApiMiddleware;
        readonly carrier: ALDeliveryCarrier;
        readonly message: ALMessage;
        readonly canFallback: boolean;
        readonly payloadIssues: readonly RallarValidationIssue[];
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
        void this.writeCapturedMessage(delivery, epoch).catch((caught) => {
            if (epoch.isOpen()) {
                epoch.settlements[delivery.carrier]({
                    kind: 'admission',
                    msgId: delivery.message.id.msgId,
                    carrier: delivery.carrier,
                    atMs: this.input.nowMs(),
                    verdict: { kind: 'failed', detail: toError(caught).message }
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
        const admission: CarrierAdmission = {
            msgId: delivery.message.id.msgId,
            carrier: delivery.carrier,
            verdict: result.verdict,
            fallback: delivery.canFallback
                ? computeFallbackDisposition(
                    result.verdict,
                    result.message.constraints?.expiresAtMs,
                    this.input.nowMs()
                )
                : 'stop'
        };
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

    private async admitCapturedMessage(
        delivery: BrowserRallarMessageDispatch.Delivery
    ): Promise<CapturedMessageAdmission> {
        const { message, context, carrier } = delivery;
        const validated = decodeALMessageValue(message);
        const issue = delivery.payloadIssues[0];
        if (issue) {
            return { message, verdict: { kind: 'refused', reason: 'oversized', detail: issue.message } };
        }
        if (validated.left) {
            return {
                message,
                verdict: { kind: 'refused', reason: validated.left.code, detail: validated.left.message }
            };
        }
        if (message.constraints?.expiresAtMs !== undefined && message.constraints.expiresAtMs <= this.input.nowMs()) {
            return {
                message,
                verdict: { kind: 'expired', detail: 'Message deadline elapsed before carrier admission.' }
            };
        }
        try {
            return await writeCarrierOutboxAdmission(context, carrier, message);
        }
        catch (caught) {
            const error = toError(caught);
            return { message, verdict: { kind: 'failed', detail: error.message } };
        }
    }
}

/** One carrier's own outbound admission of an envelope: the call a first send and its fallback both make. */
export async function writeCarrierOutboxAdmission(
    context: ApiMiddleware,
    carrier: ALDeliveryCarrier,
    message: ALMessage
): Promise<ALOutboundEnqueueResult> {
    return carrier === 'rtc'
        ? await context.middleware.rtcRxStreamer.enqueueOutboxIfAbsent(message)
        : await context.middleware.webSocketQueueBox.enqueueOutboxIfAbsent(message);
}

/** A carrier that cannot route, or cannot honour the ack algorithm (D42 keeps the algorithm, not the carrier), hands over. */
export function computeFallbackDisposition(
    verdict: ALDeliveryAdmissionVerdict,
    expiresAtMs: number | undefined,
    nowMs: number
): 'retry' | 'stop' | 'expired' {
    if (!isFallbackVerdict(verdict)) {
        return 'stop';
    }
    return expiresAtMs !== undefined && expiresAtMs <= nowMs ? 'expired' : 'retry';
}

/** A refusal the fallback carrier takes over is evidence of the refused leg, not the verdict: `rejected` is terminal. */
function toCarrierAdmissionSettlement(admission: CarrierAdmission, atMs: number): ALDeliverySettlement {
    const { msgId, carrier, verdict } = admission;
    return admission.fallback !== 'stop' && verdict.kind === 'refused'
        ? { kind: 'carrier-refused', msgId, carrier, atMs, reason: verdict.reason, detail: verdict.detail }
        : { kind: 'admission', msgId, carrier, atMs, verdict };
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
        ? { kind: 'attempts-exhausted', msgId, carrier, atMs, detail: verdict.detail }
        : undefined;
}

function isFallbackVerdict(verdict: ALDeliveryAdmissionVerdict): boolean {
    switch (verdict.kind) {
        case 'unroutable':
            return verdict.reason === 'no-route' || verdict.reason === 'circuit-open';
        case 'refused':
            return verdict.reason === 'unsupported';
        default:
            return false;
    }
}

export function wakeQueueBoxEngineIfQueued(
    engine: ApiMiddleware['middleware']['qboxEngine'],
    result: CapturedMessageAdmission
): void {
    if (result.verdict.kind === 'admitted' || result.verdict.kind === 'duplicate') {
        engine.wake();
    }
}
