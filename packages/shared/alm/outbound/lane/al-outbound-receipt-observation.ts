import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '../../../al-contracts/al-control-type-ids.ts';
import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import { fnv1a64 } from '../../../queuebox/AppQueueIdentity.ts';
import { toKeyAsString } from '../../../queuebox/ResourceEntry.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALWorkAttemptResult, ALWorkObservationDeferral } from '../../work/al-work-handler.ts';
import type { ALOutboundEffectSnapshot } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchPhase, ALOutboundMessageRuntime } from '../al-outbound-message-runtime.ts';

export interface ALOutboundReceiptFacts {
    readonly receiptControlMsgId: string;
    readonly receipt: ALReceiptPayload;
}

export interface ALOutboundReceiptWorkObservation extends ALOutboundReceiptFacts {
    readonly kind: 'receipt-work';
    readonly workerId: string;
    /** Compact joins only: the original effect/key may contain session, trace or prepared data. */
    readonly effectLocator: string;
    readonly workLocator: string;
    readonly effectKind: 'admit-message' | 'dequeue-message' | 'send-prepared';
    readonly attempts: number;
    readonly claimStartedAtMs: number | undefined;
    readonly batchStartedAtMs: number;
    readonly leaseUntilMs: number | undefined;
    readonly callbackOutcome: ALWorkAttemptResult['status'] | 'threw';
    readonly readyAtMs: number | undefined;
    readonly stage: ALOutboundReceiptWorkEvidence.Stage;
    readonly authority: ALOutboundMessageRuntime.PendingAdmissionAuthority['status'] | undefined;
    readonly admissionVerdict: ALDeliveryAdmissionVerdict['kind'] | undefined;
    readonly admissionCommitted: boolean | undefined;
    readonly decisionAtMs: number | undefined;
    readonly phase: ALOutboundDispatchPhase | undefined;
}

export type ALOutboundReceiptWorkObserver = (observation: ALOutboundReceiptWorkObservation) => void;

export namespace ALOutboundReceiptWorkEvidence {
    export type Facts = Omit<
        ALOutboundReceiptWorkObservation,
        | 'stage'
        | 'callbackOutcome'
        | 'readyAtMs'
        | 'authority'
        | 'admissionVerdict'
        | 'admissionCommitted'
        | 'decisionAtMs'
    >;

    export type Stage =
        | 'claim'
        | 'ended'
        | 'expired'
        | 'pending-authority'
        | 'pending-commit'
        | 'pending-settlement'
        | 'dequeue-gate'
        | 'dequeue-authority'
        | 'dequeue-supersedence'
        | 'dequeue-commit'
        | 'dequeue-after-admission'
        | 'send';
}

/** One callback's private evidence buffer; publishing never claims the work handler released its claim. */
export class ALOutboundReceiptWorkEvidence {
    private readonly facts: ALOutboundReceiptWorkEvidence.Facts;
    private stage: ALOutboundReceiptWorkEvidence.Stage = 'claim';
    private authority: ALOutboundMessageRuntime.PendingAdmissionAuthority['status'] | undefined;
    private admissionVerdict: ALDeliveryAdmissionVerdict['kind'] | undefined;
    private admissionCommitted: boolean | undefined;
    private decisionAtMs: number | undefined;

    readonly deferObservation: ALWorkObservationDeferral | undefined;

    constructor(
        facts: ALOutboundReceiptWorkEvidence.Facts,
        deferObservation: ALWorkObservationDeferral | undefined
    ) {
        this.facts = facts;
        this.deferObservation = deferObservation;
    }

    recordStage(stage: ALOutboundReceiptWorkEvidence.Stage): void {
        this.stage = stage;
    }

    recordAuthority(
        authority: ALOutboundMessageRuntime.PendingAdmissionAuthority['status'],
        decisionAtMs: number
    ): void {
        this.authority = authority;
        this.decisionAtMs = decisionAtMs;
    }

    recordAdmission(verdict: ALDeliveryAdmissionVerdict['kind'], committed?: boolean): void {
        this.admissionVerdict = verdict;
        this.admissionCommitted = committed;
    }

    publish(observer: ALOutboundReceiptWorkObserver, result: ALWorkAttemptResult | undefined): void {
        const observation = Object.freeze({
            ...this.facts,
            stage: this.stage,
            authority: this.authority,
            admissionVerdict: this.admissionVerdict,
            admissionCommitted: this.admissionCommitted,
            decisionAtMs: this.decisionAtMs,
            callbackOutcome: result?.status ?? 'threw',
            readyAtMs: result?.status === 'not-ready' ? result.readyAtMs : undefined
        });
        const publish = () => {
            try {
                observer(observation);
            }
            catch { /* Optional evidence cannot replace the claim's return or original exception. */ }
        };
        if (this.deferObservation === undefined) {
            publish();
        }
        else {
            this.deferObservation(publish);
        }
    }
}

export function createALOutboundReceiptWorkEvidence<TPrepared>(
    input: {
        readonly effect: ALOutboundEffectSnapshot<TPrepared>;
        readonly workerId: string;
        readonly batchStartedAtMs: number;
        deferObservation: ALWorkObservationDeferral | undefined;
    }
): ALOutboundReceiptWorkEvidence | undefined {
    const { effect, workerId, batchStartedAtMs } = input;
    const kind = effect.payload.kind;
    if (kind !== 'admit-message' && kind !== 'dequeue-message' && kind !== 'send-prepared') {
        return undefined;
    }
    const facts = effect.canonicalMessage && toALOutboundReceiptFacts(effect.canonicalMessage);
    if (facts === undefined) {
        return undefined;
    }
    return new ALOutboundReceiptWorkEvidence({
        ...facts,
        kind: 'receipt-work',
        workerId,
        effectKind: kind,
        effectLocator: fnv1a64(effect.effectId),
        workLocator: fnv1a64(toKeyAsString(effect.entry.key)),
        attempts: effect.attempts,
        claimStartedAtMs: effect.entry.dequeueAudit.startTs?.epochMilliseconds,
        batchStartedAtMs,
        leaseUntilMs: effect.leaseUntilMs,
        phase: kind === 'send-prepared' ? effect.payload.phase : undefined
    }, input.deferObservation);
}

/** Closed diagnostic projection only. It makes no authorization, delivery or admission decision. */
export function toALOutboundReceiptFacts(message: ALMessage): ALOutboundReceiptFacts | undefined {
    if (message.payload.typeId !== AL_CONTROL_RECEIPT_TYPE_ID) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(message.payload.resource);
        if (!isReceiptFacts(value)) {
            return undefined;
        }
        return Object.freeze({
            receiptControlMsgId: message.id.msgId,
            receipt: Object.freeze({
                msgId: value.msgId,
                originPeerId: value.originPeerId,
                phase: value.phase,
                expectedRecipientPeerIds: Object.freeze([...value.expectedRecipientPeerIds]),
                confirmedRecipientPeerIds: Object.freeze([...value.confirmedRecipientPeerIds]),
                snapshotVersion: value.snapshotVersion,
                observedAtEpochMs: value.observedAtEpochMs
            })
        });
    }
    catch {
        return undefined;
    }
}

function isReceiptFacts(value: unknown): value is ALReceiptPayload {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const fields = value as Readonly<Record<string, unknown>>;
    return typeof fields.msgId === 'string' && typeof fields.originPeerId === 'string' &&
        (fields.phase === 'admitted' || fields.phase === 'complete' || fields.phase === 'timed-out') &&
        Array.isArray(fields.expectedRecipientPeerIds) &&
        fields.expectedRecipientPeerIds.every((id) => typeof id === 'string') &&
        Array.isArray(fields.confirmedRecipientPeerIds) &&
        fields.confirmedRecipientPeerIds.every((id) => typeof id === 'string') &&
        typeof fields.snapshotVersion === 'number' && Number.isFinite(fields.snapshotVersion) &&
        typeof fields.observedAtEpochMs === 'number' && Number.isFinite(fields.observedAtEpochMs);
}
