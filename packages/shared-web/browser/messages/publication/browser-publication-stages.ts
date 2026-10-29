import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
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
        readonly settle: ALDeliverySettlementSink;
        /** Writes one selected delivery's carrier leg; it states its own failure as a settlement. */
        readonly submit: (delivery: LiveDelivery, epoch: BrowserDeliverySettlements.Epoch) => Promise<void>;
    }
}

interface BrowserConnectPublicationStage {
    readonly context: ApiMiddleware;
    readonly stage: ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>;
}

/**
 * Owns the connected session's one publication stage, on its connect's queue engine (D471). A live delivery of
 * another connect ends the current stage first: its values belong to a transport that no longer exists.
 */
export class BrowserPublicationStages {
    private readonly input: BrowserPublicationStages.Input;
    private current: BrowserConnectPublicationStage | undefined;

    constructor(input: BrowserPublicationStages.Input) {
        this.input = input;
    }

    stage(delivery: BrowserPublicationStages.LiveDelivery, epoch: BrowserDeliverySettlements.Epoch): void {
        const { message, carrier } = delivery;
        const result = this.readStage(delivery.context).stage({
            msg: message,
            carrier,
            policy: delivery.publication.policy,
            bytes: computeALMessageEnvelopeBytes(message).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            context: { delivery, epoch }
        });
        if (result.kind === 'refused') {
            this.input.settle({
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
    endSession(): void {
        const ended = this.current;
        this.current = undefined;
        ended?.stage.dispose();
    }

    private readStage(context: ApiMiddleware): ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery> {
        if (this.current?.context === context) {
            return this.current.stage;
        }
        this.endSession();
        const stage = new ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>({
            taskId: PUBLICATION_STAGE_TASK_ID,
            queueEngine: context.middleware.qboxEngine,
            clock: { nowMs: this.input.nowMs },
            submit: async (selected) => await this.submit(selected),
            settle: this.input.settle,
            diagnostics: context.middleware.outboundDiagnostics
        });
        this.current = { context, stage };
        return stage;
    }

    /** Every leg starts at once, in selection order, as a send's leg does; each settles its own admission. */
    private async submit(
        selected: readonly ALOutboundStagedPublication<BrowserPublicationStages.StagedDelivery>[]
    ): Promise<void> {
        await Promise.all(selected.map(({ context }) => this.input.submit(context.delivery, context.epoch)));
    }
}
