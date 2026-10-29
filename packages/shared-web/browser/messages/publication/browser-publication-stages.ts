import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import {
    ALOutboundPublicationStage,
    type ALOutboundPublicationLaneReport
} from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ALOutboundStagedPublication } from '@shared/alm/outbound/publication/al-outbound-staged-publication.ts';

/** What a live channel's delivery asks of the stage: its channel's policy, and the lane and stream it is paced on. */
export interface BrowserPublicationRequest {
    readonly policy: ALPublicationPolicy;
    readonly laneKey: string;
    readonly streamKey: string;
}

const PUBLICATION_STAGE_TASK_ID = 'al-outbound-publication-stage';

export namespace BrowserPublicationStages {
    export interface LiveDelivery extends BrowserRallarMessageDispatch.Delivery {
        readonly publication: BrowserPublicationRequest;
    }

    /** A staged delivery keeps the settlement epoch it was sent in, which its leg is written under. */
    export interface StagedDelivery {
        readonly delivery: LiveDelivery;
        readonly epoch: BrowserDeliverySettlements.Epoch;
    }

    export interface Input {
        readonly nowMs: () => number;
        /** Writes one selected delivery's carrier leg; it states its own failure as a settlement. */
        readonly submit: (delivery: LiveDelivery, epoch: BrowserDeliverySettlements.Epoch) => Promise<void>;
    }
}

interface BrowserConnectPublicationStage {
    readonly context: ApiMiddleware;
    readonly stage: ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>;
    readonly stopWatchingEpoch: RallarUnsubscribe;
}

/**
 * Owns the connected session's one publication stage, on its connect's queue engine (D471). The stage settles
 * under its connect's epoch and stops when that epoch closes, which is the first step of the connect's shutdown,
 * or when the session ends, whichever comes first.
 */
export class BrowserPublicationStages {
    private readonly input: BrowserPublicationStages.Input;
    private current: BrowserConnectPublicationStage | undefined;

    constructor(input: BrowserPublicationStages.Input) {
        this.input = input;
    }

    stage(delivery: BrowserPublicationStages.LiveDelivery, epoch: BrowserDeliverySettlements.Epoch): void {
        const { message, carrier } = delivery;
        const result = this.readStage(delivery.context, epoch).stage({
            msg: message,
            carrier,
            policy: delivery.publication.policy,
            bytes: computeALMessageEnvelopeBytes(message).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            context: { delivery, epoch }
        });
        if (result.kind === 'refused') {
            epoch.settlements[carrier]({
                kind: 'admission',
                msgId: message.id.msgId,
                traceId: message.id.traceId,
                carrier,
                atMs: this.input.nowMs(),
                verdict: { kind: 'refused', reason: result.reason, detail: result.detail },
                trackedReceiptAlgo: 'none'
            });
        }
    }

    readLane(context: ApiMiddleware, laneKey: string): ALOutboundPublicationLaneReport | undefined {
        return this.current?.context === context ? this.current.stage.readLane(laneKey) : undefined;
    }

    /** Settles every staged value `skipped`/`disposed` and takes the stage's task off its engine. */
    stopStage(): void {
        const stopped = this.current;
        this.current = undefined;
        stopped?.stopWatchingEpoch();
        stopped?.stage.dispose();
    }

    /** A delivery of another connect stops the current stage first: one connect holds staged values at a time. */
    private readStage(
        context: ApiMiddleware,
        epoch: BrowserDeliverySettlements.Epoch
    ): ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery> {
        if (this.current?.context === context) {
            return this.current.stage;
        }
        this.stopStage();
        const stage = new ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>({
            taskId: PUBLICATION_STAGE_TASK_ID,
            queueEngine: context.middleware.qboxEngine,
            clock: { nowMs: this.input.nowMs },
            submit: async (selected) => await this.submit(selected),
            settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
            diagnostics: context.middleware.outboundDiagnostics
        });
        this.current = { context, stage, stopWatchingEpoch: epoch.onClose(() => this.stopStage()) };
        return stage;
    }

    /** Every leg starts at once, in selection order, as a send's leg does; each settles its own admission. */
    private async submit(
        selected: readonly ALOutboundStagedPublication<BrowserPublicationStages.StagedDelivery>[]
    ): Promise<void> {
        await Promise.all(selected.map(({ context }) => this.input.submit(context.delivery, context.epoch)));
    }
}
