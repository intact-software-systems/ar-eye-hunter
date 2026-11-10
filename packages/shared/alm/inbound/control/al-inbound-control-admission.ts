import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALAckPayload, ALControlAcceptance } from '../../../al-contracts/al-control.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { toExpireAtTimestampFromNow } from '../../ALStoreRetention.ts';
import { computeALVolatileControlRowExpiryMs } from '../../delivery/compute-al-volatile-control-row-expiry-ms.ts';
import { isALRelayedNackReason } from '../../delivery/is-al-relayed-nack-reason.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundControlDecisionSurface,
    ALInboundMessageOwner
} from '../al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import { toALInboundPendingControlId } from '../al-inbound-pending-admission.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../al-inbound-runtime-diagnostics.ts';
import { toALDeliveryCarrier, toALInboundMessageOwnerKey } from '../al-inbound-source-validation.ts';
import { computeALInboundWorkEntry } from '../al-inbound-work-entry.ts';
import {
    signALInboundReceiptControls,
    type ALInboundReceiptProofs
} from '../receipt-proof/sign-al-inbound-receipt-controls.ts';
import type { ALInboundAcknowledgementEvidence } from './al-inbound-acknowledgement-evidence.ts';
import type { ALInboundControlSubject } from './al-inbound-control-rows.ts';
import {
    computeALInboundControlAdmission,
    toALInboundControlCommitBundle,
    type ALInboundControlAdmissionCandidate,
    type ALInboundControlAdmissionRead
} from './compute-al-inbound-control-admission.ts';
import {
    computeALInboundNackAdmission,
    toALInboundNackCommitBundle,
    type ALInboundNackAdmissionRead
} from './compute-al-inbound-nack-admission.ts';
import { validateALInboundControlAdmission } from './validate-al-inbound-control-admission.ts';
import { validateALInboundNackAdmission } from './validate-al-inbound-nack-admission.ts';

export interface ALInboundControlAdmissionDependencies {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly port: ALWorkQueuePort;
    readonly clock: ALInboundMessageRuntime.Clock;
    readonly newControlId: () => string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    readonly receiptProofs: ALInboundReceiptProofs;
    readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
}

export type ALInboundControlAdmissionResult =
    | Readonly<{ kind: 'not-handled'; }>
    | Readonly<{
        kind: 'committed';
        acceptance: ALControlAcceptance;
    }>
    | Readonly<{ kind: 'pending-control'; }>
    | Readonly<{ kind: 'rejected'; reason: string; }>
    /** The store could not persist the control, so it wrote nothing; an inline caller answers it not handled. */
    | ALInboundMessageRuntime.UnpersistedControl;

export interface ALInboundPendingControl {
    readonly kind: 'admit-control';
    readonly msg: ALMessage;
    /** The carrier the control arrived on: its acknowledgement is recorded, and its replay claimed, under it. */
    readonly carrier: ALDeliveryCarrier;
    readonly expiresAtMs: number;
}

type ALInboundControlArrival = Pick<ALInboundPendingControl, 'msg' | 'carrier'>;

/** What an admitted ACK or NACK commits, the acceptance it returns, and the admission clock its retention uses. */
interface ALInboundControlCommit {
    readonly bundle: ALInboundCommitBundle;
    readonly acceptance: ALControlAcceptance;
    readonly nowMs: number;
}

/** A replay that commits owes its caller the same acceptance the inline admission returned. */
export interface ALInboundControlReplayResult {
    readonly outcome: ALWorkOutcome;
    readonly acceptance: ALControlAcceptance | undefined;
    /**
     * The replay's own commit persisted work behind the page its batch read; nothing else announces it.
     * Every committed acknowledgement relays at least the recipient it names, so a commit always writes work.
     */
    readonly wroteWork: boolean;
}

/** One conditional admission per call; a conflict becomes retained work the inbound worker replays. */
export class ALInboundControlAdmission {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly port: ALWorkQueuePort;
    private readonly clock: ALInboundMessageRuntime.Clock;
    private readonly newControlId: () => string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;
    private readonly receiptProofs: ALInboundReceiptProofs;
    private readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;

    constructor(dependencies: ALInboundControlAdmissionDependencies) {
        this.admissionStore = dependencies.admissionStore;
        this.port = dependencies.port;
        this.clock = dependencies.clock;
        this.newControlId = dependencies.newControlId;
        this.retention = dependencies.retention;
        this.receiptProofs = dependencies.receiptProofs;
        this.diagnostics = dependencies.diagnostics;
    }

    async admit(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        evidence?: ALInboundAcknowledgementEvidence
    ): Promise<ALInboundControlAdmissionResult> {
        return await this.admitArrival({ msg, carrier: toALDeliveryCarrier(source) }, evidence);
    }

    async replay(
        payload: ALInboundPendingControl,
        evidence?: ALInboundAcknowledgementEvidence
    ): Promise<ALInboundControlReplayResult> {
        if (payload.expiresAtMs <= this.clock.nowMs()) {
            evidence?.admissionResult('expired');
            return { outcome: { status: 'completed' }, acceptance: undefined, wroteWork: false };
        }
        const result = await this.admitArrival(payload, evidence);
        evidence?.admissionResult(result.kind);
        return {
            outcome: { status: result.kind === 'pending-control' ? 'retry' : 'completed' },
            acceptance: result.kind === 'committed' ? result.acceptance : undefined,
            wroteWork: result.kind === 'committed'
        };
    }

    /** A relay admits a child's ACK, and the NACKs it relays; every other control is its outbound owner's. */
    private async admitArrival(
        arrival: ALInboundControlArrival,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const control = decodeALControlMessage(arrival.msg).right;
        if (control?.type === 'ack') {
            return await this.admitAcknowledgement(arrival, { ...control.payload, carrier: arrival.carrier }, evidence);
        }
        return control?.type === 'nack' && isALRelayedNackReason(control.payload.reason)
            ? await this.admitRelayedNack(
                arrival,
                { ...control.payload, reason: control.payload.reason },
                evidence
            )
            : { kind: 'not-handled' };
    }

    private async admitAcknowledgement(
        arrival: ALInboundControlArrival,
        ack: ALAckPayload,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const nowMs = this.clock.nowMs();
        const read = await this.readControlAdmission(arrival, ack, nowMs);
        if (read === undefined) {
            return { kind: 'not-handled' };
        }
        const candidate = computeALInboundControlAdmission(read, this.retention);
        const issues = validateALInboundControlAdmission(candidate);
        evidence?.candidate(candidate, issues.length === 0);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(arrival, {
            bundle: toALInboundControlCommitBundle(this.toStoreCandidate(candidate)),
            acceptance: candidate.acceptance,
            nowMs: candidate.read.nowMs
        }, evidence);
    }

    private async admitRelayedNack(
        arrival: ALInboundControlArrival,
        nack: ALInboundNackAdmissionRead['nack'],
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const nowMs = this.clock.nowMs();
        const surface = await this.readDecisionSurface({ msgId: nack.msgId, fromPeerId: nack.fromPeerId });
        if (surface === undefined) {
            return { kind: 'not-handled' };
        }
        const candidate = computeALInboundNackAdmission({
            namespace: this.admissionStore.namespace,
            nack,
            controlOwners: surface.controlOwners,
            owner: surface.owner,
            pending: surface.pendingAck,
            acks: surface.acks,
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        }, this.retention);
        const issues = validateALInboundNackAdmission(candidate);
        evidence?.candidate(candidate, issues.length === 0);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(arrival, {
            bundle: toALInboundNackCommitBundle(candidate),
            acceptance: candidate.acceptance,
            nowMs
        }, evidence);
    }

    private async commitControlAdmission(
        arrival: ALInboundControlArrival,
        admitted: ALInboundControlCommit,
        evidence: ALInboundAcknowledgementEvidence | undefined
    ): Promise<ALInboundControlAdmissionResult> {
        const signed = await signALInboundReceiptControls({
            bundle: admitted.bundle,
            namespace: this.admissionStore.namespace,
            receiptProofs: this.receiptProofs,
            diagnostics: this.diagnostics
        });
        evidence?.commit('pending');
        const status = await this.admissionStore.commitBundle(signed);
        evidence?.commit(status);
        if (status === 'committed') {
            return { kind: 'committed', acceptance: admitted.acceptance };
        }
        evidence?.retention('pending');
        await this.retainPendingControl(arrival, admitted.nowMs);
        evidence?.retention('returned');
        return { kind: 'pending-control' };
    }

    /**
     * The volatile pair keeps a message's acknowledgement history no longer than its deadline plus the receipt grace
     * (D74): the control-owner index that admits an acknowledgement expires at the deadline, and a data copy past it
     * is refused expired. A relay row of a message that named no deadline carries none, so its history keeps the TTL.
     */
    private toStoreCandidate(candidate: ALInboundControlAdmissionCandidate): ALInboundControlAdmissionCandidate {
        return {
            ...candidate,
            controlExpireAtTimestamp: computeALVolatileControlRowExpiryMs(
                candidate.controlExpireAtTimestamp,
                this.admissionStore.durability,
                candidate.read.pending?.expireAtTimestamp
            )
        };
    }

    private async retainPendingControl(arrival: ALInboundControlArrival, nowMs: number): Promise<void> {
        const expiresAtMs = toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs, nowMs);
        const work = computeALInboundWorkEntry({
            namespace: this.admissionStore.namespace,
            effectId: toALInboundPendingControlId(arrival.msg),
            payload: { kind: 'admit-control', msg: arrival.msg, carrier: arrival.carrier, expiresAtMs },
            observedAtMs: nowMs,
            expireAtTimestamp: expiresAtMs,
            carrier: arrival.carrier,
            signsForRecipient: false
        });
        await this.port.retainIfAbsent(work.entry);
    }

    /**
     * An acknowledgement whose peer owns no tracked message, or an ambiguous one, is not handled. The ACKs it relays
     * carry the trace of the acknowledgement they relay, which names the acknowledged message's trace.
     */
    private async readControlAdmission(
        arrival: ALInboundControlArrival,
        ack: ALAckPayload,
        nowMs: number
    ): Promise<ALInboundControlAdmissionRead | undefined> {
        const surface = await this.readDecisionSurface({ msgId: ack.ackedMsgId, fromPeerId: ack.fromPeerId });
        return surface === undefined ? undefined : {
            namespace: this.admissionStore.namespace,
            ack,
            controlOwners: surface.controlOwners,
            owner: surface.owner,
            pending: surface.pendingAck,
            acks: surface.acks,
            nowMs,
            controlMsgId: this.newControlId(),
            traceId: arrival.msg.id.traceId
        };
    }

    /** The surface of a child's control: none for a peer that owes no tracked message, never one without provenance. */
    private async readDecisionSurface(
        subject: ALInboundControlSubject
    ): Promise<(ALInboundControlDecisionSurface & { readonly owner: ALInboundMessageOwner; }) | undefined> {
        const surface = await this.admissionStore.readControlDecisionSurface(subject);
        if (surface === undefined) {
            return undefined;
        }
        if (surface.messageOwner === undefined) {
            throw new ALAdmissionCorruptionError(
                toALInboundMessageOwnerKey(this.admissionStore.namespace, subject.msgId, surface.senderId),
                new TypeError('Retained inbound acknowledgement state has no message provenance')
            );
        }
        return { ...surface, owner: surface.messageOwner };
    }
}
