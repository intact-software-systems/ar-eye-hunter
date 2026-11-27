import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    ALOutboundPublicationStage,
    toIdleALOutboundPublicationStageReport,
    type ALOutboundPublicationLaneReport,
    type ALOutboundPublicationStageReport
} from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ALOutboundStagedPublication } from '@shared/alm/outbound/publication/al-outbound-staged-publication.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';
import { toError } from '@shared/resilience/to-error.ts';

/** How a live channel's value is paced: its channel's policy, and the lane and stream it is paced on. */
export interface BrowserPublicationPacing {
    readonly policy: ALPublicationPolicy;
    readonly laneKey: string;
    readonly streamKey: string;
}

/** A live value as it leaves the stage: its envelope with the stamped payload, and what that payload is refused for. */
export interface BrowserStampedPublication {
    readonly message: ALMessage;
    readonly payloadIssues: readonly RallarValidationIssue[];
}

/** What a live channel's delivery asks of the stage, and of the dispatch that writes its leg at its opportunity. */
export interface BrowserPublicationRequest extends BrowserPublicationPacing {
    /**
     * Defined exactly on an edge-ordered live channel. The dispatch calls it once, when the stage's opportunity
     * selects the value and before its leg is written: it wraps the payload with the position the value takes
     * then, so a value displaced on the stage takes none.
     */
    readonly stampAtOpportunity: ((message: ALMessage) => BrowserStampedPublication) | undefined;
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
        /** Writes the delivery's carrier leg once an opportunity selects it; it states its own failure as a settlement. */
        readonly writeLeg: () => Promise<void>;
    }
}

interface BrowserConnectPublicationStage {
    readonly context: ApiMiddleware;
    readonly stage: ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>;
}

/**
 * Owns the connected session's one publication stage, on its connect's queue engine (D471). The stage settles
 * under its connect's epoch and stops when that epoch closes, which is the first step of the connect's shutdown,
 * or when the session ends, whichever comes first. The delivery registry's cancel reaches it before the carriers
 * (D479), so it is built before the registry and each staged delivery carries its own leg writer.
 */
export class BrowserPublicationStages {
    private current: BrowserConnectPublicationStage | undefined;

    stage(staged: BrowserPublicationStages.StagedDelivery): void {
        if (this.current?.context === staged.delivery.context) {
            this.stageOn(this.current.stage, staged);
            return;
        }
        this.startStage(staged);
    }

    /** Settles a value the current stage holds `cancelled` under its epoch; false when no stage holds it. */
    cancel(msgId: string): boolean {
        return this.current?.stage.cancel(msgId) ?? false;
    }

    /** The connect's stage report; a connect whose stage has not started, or has stopped, reports it idle (D480). */
    readReport(context: ApiMiddleware): ALOutboundPublicationStageReport {
        return this.current?.context === context
            ? this.current.stage.readReport()
            : toIdleALOutboundPublicationStageReport(context.middleware.publicationStageLimits);
    }

    /** One lane of the connect's stage; only the tests read it, and the usage report reads `readReport`. */
    readLane(context: ApiMiddleware, laneKey: string): ALOutboundPublicationLaneReport | undefined {
        return this.current?.context === context ? this.current.stage.readLane(laneKey) : undefined;
    }

    /** Settles every staged value `skipped`/`disposed` and takes the stage's task off its engine. */
    stopStage(): void {
        const stopped = this.current;
        this.current = undefined;
        stopped?.stage.dispose();
    }

    /**
     * A delivery of another connect stops the current stage first: one connect holds staged values at a time. The new
     * stage watches its epoch once it holds the delivery, so an epoch already closing stops it at once, under that epoch.
     */
    private startStage(staged: BrowserPublicationStages.StagedDelivery): void {
        this.stopStage();
        const { delivery: { context }, epoch } = staged;
        const stage = new ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>({
            taskId: PUBLICATION_STAGE_TASK_ID,
            queueEngine: context.middleware.qboxEngine,
            clock: { nowMs: () => context.serverTime.readWorkEpochMs() },
            submit: async (selected) => await this.submit(selected),
            settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
            diagnostics: context.middleware.outboundDiagnostics,
            limits: context.middleware.publicationStageLimits
        });
        this.current = { context, stage };
        this.stageOn(stage, staged);
        epoch.onClose(() => this.stopStageOf(stage));
    }

    private stopStageOf(stage: ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>): void {
        if (this.current?.stage === stage) {
            this.stopStage();
        }
    }

    private stageOn(
        stage: ALOutboundPublicationStage<BrowserPublicationStages.StagedDelivery>,
        staged: BrowserPublicationStages.StagedDelivery
    ): void {
        const { delivery, epoch } = staged;
        const { message, carrier } = delivery;
        const result = stage.stage({
            msg: message,
            carrier,
            policy: delivery.publication.policy,
            bytes: computeALMessageEnvelopeBytes(message).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            context: staged
        });
        if (result.kind === 'refused') {
            this.settleAdmission(delivery, epoch, result);
        }
    }

    /**
     * Every leg starts at once, in selection order, as a send's leg does; each settles its own admission. A leg that
     * rejects settles `failed` alone, and the opportunity rejects only when every leg did, so the stage settles them.
     */
    private async submit(
        selected: readonly ALOutboundStagedPublication<BrowserPublicationStages.StagedDelivery>[]
    ): Promise<void> {
        const outcomes = await Promise.allSettled(selected.map(({ context }) => context.writeLeg()));
        const failures = selected.flatMap(({ context }, index) => {
            const outcome = outcomes[index];
            return outcome?.status === 'rejected' ? [{ context, error: toError(outcome.reason) }] : [];
        });
        const [firstFailure] = failures;
        if (firstFailure !== undefined && failures.length === selected.length) {
            throw firstFailure.error;
        }
        failures.forEach(({ context, error }) =>
            this.settleAdmission(context.delivery, context.epoch, { kind: 'failed', detail: error.message })
        );
    }

    private settleAdmission(
        delivery: BrowserPublicationStages.LiveDelivery,
        epoch: BrowserDeliverySettlements.Epoch,
        verdict: ALDeliveryAdmissionVerdict
    ): void {
        const { message, carrier } = delivery;
        epoch.settlements[carrier]({
            kind: 'admission',
            msgId: message.id.msgId,
            traceId: message.id.traceId,
            carrier,
            atMs: delivery.context.serverTime.readWorkEpochMs(),
            verdict,
            trackedReceiptAlgo: 'none'
        });
    }
}
