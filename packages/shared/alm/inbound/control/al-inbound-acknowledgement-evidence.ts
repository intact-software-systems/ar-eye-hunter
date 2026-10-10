import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckPayload } from '../../../al-contracts/al-control.ts';
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALWorkBatchObservations } from '../../work/al-work-batch-observations.ts';
import type { ALWorkObservationDeferral } from '../../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome } from '../../work/al-work-queue-port.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../al-inbound-runtime-diagnostics.ts';
import { toALDeliveryCarrier } from '../al-inbound-source-validation.ts';
import type { ALPersistedInboundEffect } from '../al-inbound-work-entry.ts';
import type { ALInboundControlAdmissionResult } from './al-inbound-control-admission.ts';
import type { ALInboundControlAdmissionCandidate } from './compute-al-inbound-control-admission.ts';

export namespace ALInboundAcknowledgementEvidence {
    /** Explicitly installed by a capturing consumer; ordinary callable sinks allocate no ACK evidence. */
    export interface Capture {
        readonly evidence: typeof ALInboundAcknowledgementEvidence;
        readonly batchObservations: typeof ALWorkBatchObservations;
    }

    export interface Input {
        readonly msg: ALMessage;
        readonly carrier: ALDeliveryCarrier;
        readonly sink: ALInboundRuntimeDiagnosticsSink;
        readonly workerId: string;
    }

    export interface ClaimInput {
        readonly effect: ALPersistedInboundEffect;
        readonly claim: ALWorkClaim;
        readonly lane: ALStoreDurability;
        readonly sink: ALInboundRuntimeDiagnosticsSink;
        readonly workerId: string;
        readonly batchStartedAtMs: number;
        readonly claimStartedAtMs: number;
        readonly defer: ALWorkObservationDeferral | undefined;
    }

    /** Closed claim context; no work row or payload reference survives setup. */
    export interface Claim {
        readonly kind: 'admit-control' | 'send-control';
        readonly lane: ALStoreDurability;
        readonly batchStartedAtMs: number;
        readonly claimStartedAtMs: number;
        readonly claimAttempt: number;
        readonly defer: ALWorkObservationDeferral | undefined;
    }

    export interface Identity {
        readonly controlMsgId: string;
        readonly controlSenderId: string;
        readonly subjectMsgId: string;
        readonly originPeerId: string;
        readonly logicalRecipientPeerId: string;
        readonly fromPeerId: string;
        readonly toPeerId: string;
        readonly carrier: ALDeliveryCarrier;
        readonly status: ALAckPayload['status'];
        readonly producerObservedAtEpochMs: number;
    }

    export interface Candidate {
        readonly ownerPeerId: string;
        readonly ownerSourceKind: ALInboundMessageRuntime.Source['kind'];
        readonly ownerCarrier: ALDeliveryCarrier;
        readonly parentPeerId: string | null;
        readonly generated: readonly Identity[];
        readonly validated: boolean;
        /** Existing admission clock, not capture/publication time. */
        readonly computedAtMs: number;
    }

    export interface Attempt {
        readonly lane: ALStoreDurability;
        readonly candidate: Candidate | null;
        readonly commit: 'not-called' | 'pending' | 'committed' | 'conflict' | 'expired';
        readonly retention: 'not-called' | 'pending' | 'returned';
        readonly result: ALInboundControlAdmissionResult['kind'] | 'expired' | 'threw';
    }

    export interface Association {
        readonly kind: 'acknowledgement-association';
        readonly workerId: string;
        readonly incoming: Identity;
        readonly attempts: readonly Attempt[];
        readonly terminalOrigin: boolean;
        readonly phase: 'ingress' | 'replay';
        readonly result: ALInboundMessageRuntime.Admission['kind'] | ALWorkOutcome['status'] | 'rejected' | 'threw';
    }

    export interface Handoff {
        readonly kind: 'acknowledgement-handoff';
        readonly workerId: string;
        readonly control: Identity;
        readonly lane: ALStoreDurability;
        readonly batchStartedAtMs: number;
        readonly claimStartedAtMs: number;
        readonly claimAttempt: number;
        /** Pending plus `threw` means the call failed; returned plus `threw` means the enclosing callback later failed. */
        readonly handoff:
            | 'not-called'
            | 'batch-pending'
            | 'batch-returned'
            | 'single-pending'
            | 'single-returned'
            | 'fallback-pending'
            | 'fallback-returned';
        readonly result: ALWorkOutcome['status'] | 'threw';
    }
}

/** Closed facts of one ACK invocation; it never reads stores, generates IDs, reads clocks or changes work. */
export class ALInboundAcknowledgementEvidence {
    private readonly attempts: ALInboundAcknowledgementEvidence.Attempt[] = [];
    private claim: ALInboundAcknowledgementEvidence.Claim | undefined;
    private valid = true;
    private terminalOrigin = false;
    private handoff: ALInboundAcknowledgementEvidence.Handoff['handoff'] = 'not-called';

    private readonly incoming: ALInboundAcknowledgementEvidence.Identity;
    private readonly sink: ALInboundRuntimeDiagnosticsSink;
    private readonly workerId: string;

    constructor(
        incoming: ALInboundAcknowledgementEvidence.Identity,
        sink: ALInboundRuntimeDiagnosticsSink,
        workerId: string
    ) {
        this.incoming = incoming;
        this.sink = sink;
        this.workerId = workerId;
    }

    static tryCreate(input: ALInboundAcknowledgementEvidence.Input): ALInboundAcknowledgementEvidence | undefined {
        try {
            const identity = toAcknowledgementIdentity(input.msg, input.carrier);
            return identity === undefined ? undefined : new this(identity, input.sink, input.workerId);
        }
        catch {
            return undefined;
        }
    }

    static tryCreateClaim(
        input: ALInboundAcknowledgementEvidence.ClaimInput
    ): ALInboundAcknowledgementEvidence | undefined {
        try {
            const { payload, carrier } = input.effect;
            if (payload.kind !== 'admit-control' && payload.kind !== 'send-control') {
                return undefined;
            }
            const identity = toAcknowledgementIdentity(payload.msg, carrier);
            if (identity === undefined) {
                return undefined;
            }
            const evidence = new this(identity, input.sink, input.workerId);
            evidence.claim = Object.freeze({
                kind: payload.kind,
                lane: input.lane,
                batchStartedAtMs: input.batchStartedAtMs,
                claimStartedAtMs: input.claimStartedAtMs,
                claimAttempt: input.claim.attempts,
                defer: input.defer
            });
            return evidence;
        }
        catch {
            return undefined;
        }
    }

    beginAttempt(lane: ALStoreDurability): void {
        try {
            this.attempts.push({
                lane,
                candidate: null,
                commit: 'not-called',
                retention: 'not-called',
                result: 'threw'
            });
        }
        catch {
            this.valid = false;
        }
    }

    candidate(candidate: ALInboundControlAdmissionCandidate, validated: boolean): void {
        try {
            const generated = candidate.upwardEffects.map((effect) => {
                const identity = effect.payload.kind === 'send-control'
                    ? toAcknowledgementIdentity(effect.payload.msg, effect.carrier)
                    : undefined;
                if (identity === undefined) {
                    throw new TypeError('Expected acknowledgement work');
                }
                return identity;
            });
            const snapshot = Object.freeze({
                ownerPeerId: candidate.read.owner.senderId,
                ownerSourceKind: candidate.read.owner.source.kind,
                ownerCarrier: toALDeliveryCarrier(candidate.read.owner.source),
                parentPeerId: candidate.read.pending?.toPeerId ?? null,
                generated: Object.freeze(generated),
                validated,
                computedAtMs: candidate.read.nowMs
            });
            this.updateAttempt({ candidate: snapshot });
        }
        catch {
            this.valid = false;
        }
    }

    commit(status: ALInboundAcknowledgementEvidence.Attempt['commit']): void {
        this.updateAttempt({ commit: status });
    }

    retention(status: ALInboundAcknowledgementEvidence.Attempt['retention']): void {
        this.updateAttempt({ retention: status });
    }

    admissionResult(result: ALInboundAcknowledgementEvidence.Attempt['result']): void {
        this.updateAttempt({ result });
    }

    originBypass(): void {
        this.terminalOrigin = true;
    }

    handoffState(state: ALInboundAcknowledgementEvidence.Handoff['handoff']): void {
        this.handoff = state;
    }

    publishAssociation(
        phase: ALInboundAcknowledgementEvidence.Association['phase'],
        result: ALInboundAcknowledgementEvidence.Association['result'],
        defer?: ALWorkObservationDeferral
    ): void {
        try {
            const event: ALInboundAcknowledgementEvidence.Association = Object.freeze({
                kind: 'acknowledgement-association',
                workerId: this.workerId,
                incoming: this.incoming,
                attempts: Object.freeze(this.attempts.map((attempt) => Object.freeze({ ...attempt }))),
                terminalOrigin: this.terminalOrigin,
                phase,
                result
            });
            this.publish(event, defer);
        }
        catch { /* Optional projection cannot replace a return or original exception. */ }
    }

    publishClaim(result: ALInboundAcknowledgementEvidence.Handoff['result']): void {
        try {
            const claim = this.claim;
            if (claim === undefined) {
                return;
            }
            if (claim.kind === 'admit-control') {
                this.publishAssociation('replay', result, claim.defer);
                return;
            }
            this.publish(
                Object.freeze({
                    kind: 'acknowledgement-handoff',
                    workerId: this.workerId,
                    control: this.incoming,
                    lane: claim.lane,
                    batchStartedAtMs: claim.batchStartedAtMs,
                    claimStartedAtMs: claim.claimStartedAtMs,
                    claimAttempt: claim.claimAttempt,
                    handoff: this.handoff,
                    result
                }),
                claim.defer
            );
        }
        catch { /* Optional projection cannot change the claim's result. */ }
    }

    private updateAttempt(update: Partial<ALInboundAcknowledgementEvidence.Attempt>): void {
        try {
            const last = this.attempts.length - 1;
            if (last < 0) {
                return;
            }
            this.attempts[last] = { ...this.attempts[last]!, ...update };
        }
        catch {
            this.valid = false;
        }
    }

    private publish(
        event: ALInboundAcknowledgementEvidence.Association | ALInboundAcknowledgementEvidence.Handoff,
        defer: ALWorkObservationDeferral | undefined
    ): void {
        if (!this.valid) {
            return;
        }
        const publish = () => {
            try {
                this.sink(event);
            }
            catch { /* Diagnostics cannot affect mandatory work. */ }
        };
        if (defer === undefined) {
            publish();
        }
        else {
            defer(publish);
        }
    }
}

function toAcknowledgementIdentity(
    msg: ALMessage,
    carrier: ALDeliveryCarrier
): ALInboundAcknowledgementEvidence.Identity | undefined {
    const decoded = decodeALControlMessage(msg);
    if (decoded.left || decoded.right!.type !== 'ack') {
        return undefined;
    }
    const ack = decoded.right!.payload;
    return Object.freeze({
        controlMsgId: msg.id.msgId,
        controlSenderId: msg.id.senderId,
        subjectMsgId: ack.ackedMsgId,
        originPeerId: ack.originPeerId,
        logicalRecipientPeerId: ack.logicalRecipientPeerId,
        fromPeerId: ack.fromPeerId,
        toPeerId: ack.toPeerId,
        carrier,
        status: ack.status,
        producerObservedAtEpochMs: ack.observedAtEpochMs
    });
}
