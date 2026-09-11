import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALAckPayload, ALControlAcceptance } from '../../../al-contracts/al-control.ts';
import { decodeALControlMessage } from '../../../al-contracts/al-control.ts';
import { ALAdmissionCorruptionError } from '../../al-admission-decoder.ts';
import type { NormalizedALRuntimeStoreRetentionConfig } from '../../ALStoreRetention.ts';
import { toExpireAtTimestampFromNow } from '../../ALStoreRetention.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type { ALInboundAdmissionStore } from '../al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import { toALInboundPendingControlId } from '../al-inbound-pending-admission.ts';
import { toALInboundMessageOwnerKey } from '../al-inbound-source-validation.ts';
import { computeALInboundWorkEntry } from '../al-inbound-work-entry.ts';
import {
    computeALInboundControlAdmission,
    toALInboundControlCommitBundle,
    type ALInboundControlAdmissionCandidate,
    type ALInboundControlAdmissionRead
} from './compute-al-inbound-control-admission.ts';
import { validateALInboundControlAdmission } from './validate-al-inbound-control-admission.ts';

export interface ALInboundControlAdmissionDependencies {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly port: ALWorkQueuePort;
    readonly clock: ALInboundMessageRuntime.Clock;
    readonly newControlId: () => string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export type ALInboundControlAdmissionResult =
    | Readonly<{ kind: 'not-handled'; }>
    | Readonly<{ kind: 'committed'; acceptance: ALControlAcceptance; }>
    | Readonly<{ kind: 'pending-control'; }>
    | Readonly<{ kind: 'rejected'; reason: string; }>;

export interface ALInboundPendingControl {
    readonly kind: 'admit-control';
    readonly msg: ALMessage;
    readonly expiresAtMs: number;
}

/** A replay that commits owes its caller the same acceptance the inline admission returned. */
export interface ALInboundControlReplayResult {
    readonly outcome: ALWorkOutcome;
    readonly acceptance: ALControlAcceptance | undefined;
}

/** One conditional admission per call; a conflict becomes retained work the inbound worker replays. */
export class ALInboundControlAdmission {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly port: ALWorkQueuePort;
    private readonly clock: ALInboundMessageRuntime.Clock;
    private readonly newControlId: () => string;
    private readonly retention: NormalizedALRuntimeStoreRetentionConfig;

    constructor(dependencies: ALInboundControlAdmissionDependencies) {
        this.admissionStore = dependencies.admissionStore;
        this.port = dependencies.port;
        this.clock = dependencies.clock;
        this.newControlId = dependencies.newControlId;
        this.retention = dependencies.retention;
    }

    async admit(msg: ALMessage): Promise<ALInboundControlAdmissionResult> {
        const decoded = decodeALControlMessage(msg);
        if (decoded.left || decoded.right!.type !== 'ack') {
            return { kind: 'not-handled' };
        }
        const nowMs = this.clock.nowMs();
        const read = await this.readControlAdmission(decoded.right!.payload, nowMs);
        if (read === undefined) {
            return { kind: 'not-handled' };
        }
        const candidate = computeALInboundControlAdmission(read, this.retention);
        const issues = validateALInboundControlAdmission(candidate);
        if (issues.length > 0) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        return await this.commitControlAdmission(msg, candidate, nowMs);
    }

    async replay(payload: ALInboundPendingControl): Promise<ALInboundControlReplayResult> {
        if (payload.expiresAtMs <= this.clock.nowMs()) {
            return { outcome: { status: 'completed' }, acceptance: undefined };
        }
        const result = await this.admit(payload.msg);
        return {
            outcome: { status: result.kind === 'pending-control' ? 'retry' : 'completed' },
            acceptance: result.kind === 'committed' ? result.acceptance : undefined
        };
    }

    private async commitControlAdmission(
        msg: ALMessage,
        candidate: ALInboundControlAdmissionCandidate,
        nowMs: number
    ): Promise<ALInboundControlAdmissionResult> {
        const status = await this.admissionStore.commitBundle(toALInboundControlCommitBundle(candidate));
        if (status === 'committed') {
            return { kind: 'committed', acceptance: candidate.acceptance };
        }
        await this.retainPendingControl(msg, nowMs);
        return { kind: 'pending-control' };
    }

    private async retainPendingControl(msg: ALMessage, nowMs: number): Promise<void> {
        const expiresAtMs = toExpireAtTimestampFromNow(this.retention.durableEffectTtlMs, nowMs);
        const work = computeALInboundWorkEntry({
            namespace: this.admissionStore.namespace,
            effectId: toALInboundPendingControlId(msg),
            payload: { kind: 'admit-control', msg, expiresAtMs },
            observedAtMs: nowMs,
            expireAtTimestamp: expiresAtMs
        });
        await this.port.retainIfAbsent(work.entry);
    }

    /** An acknowledgement whose peer owns no tracked message, or an ambiguous one, is not handled. */
    private async readControlAdmission(
        ack: ALAckPayload,
        nowMs: number
    ): Promise<ALInboundControlAdmissionRead | undefined> {
        const surface = await this.admissionStore.readControlDecisionSurface(ack);
        if (surface === undefined) {
            return undefined;
        }
        if (surface.messageOwner === undefined) {
            throw new ALAdmissionCorruptionError(
                toALInboundMessageOwnerKey(this.admissionStore.namespace, ack.ackedMsgId, surface.senderId),
                new TypeError('Retained inbound acknowledgement state has no message provenance')
            );
        }
        return {
            namespace: this.admissionStore.namespace,
            ack,
            controlOwners: surface.controlOwners,
            owner: surface.messageOwner,
            pending: surface.pendingAck,
            acks: surface.acks,
            nowMs,
            controlMsgId: this.newControlId()
        };
    }
}
