import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkAttemptResult,
    type ALWorkDiagnostics,
    type ALWorkReadySelection
} from '../../work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkClaim, type ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from '../admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import { ALOutboundMessageEffects } from '../al-outbound-message-effects.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores,
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from '../al-outbound-message-runtime.ts';
import { ALOutboundRepairAdmission } from '../al-outbound-repair-admission.ts';
import { ALOutboundRepairRetransmission } from '../al-outbound-repair-retransmission.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    toALOutboundDequeueWork,
    toALOutboundWorkType,
    type ALOutboundDequeueDeferral
} from '../al-outbound-work-entry.ts';
import type { ALOutboundControlSource } from '../compute-al-outbound-control-admission.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmissionResult } from '../control/al-outbound-control-admission.ts';
import { ALOutboundReceiptAdmission } from '../control/al-outbound-receipt-admission.ts';
import type { ALOutboundCanonicalHandoff } from './al-outbound-canonical-handoff.ts';
import type { ALOutboundSendControls } from './al-outbound-send-controls.ts';

export namespace ALOutboundStoreLane {
    export interface Input<TPrepared> {
        /** Named on every diagnostic this lane states. */
        readonly lane: ALStoreDurability;
        readonly stores: ALOutboundRuntimeStores<TPrepared>;
        readonly workerId: string;
        /** Foreign queue rows only the durable lane admits; the volatile lane names none. */
        readonly dequeueTypes: ReadonlySet<string>;
        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
        /** The memory pair's sweep; undefined for a lane over a durable pair. */
        readonly evictExpired: (() => void) | undefined;
        /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
        readonly canonicalHandoff: ALOutboundCanonicalHandoff | undefined;
        readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
        readonly sendControls: ALOutboundSendControls;
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

/**
 * One store pair of an outbound owner and the work that runs over it: admission, controls, receipts and
 * the owner's engine task. A lane over the memory pair persists nothing, so no admission it states is
 * durable, and it sweeps its own expired rows on its work round.
 */
export class ALOutboundStoreLane<TPrepared> {
    private readonly input: ALOutboundStoreLane.Input<TPrepared>;
    private readonly readyPromise: Promise<void>;
    private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    private readonly receiptAdmission: ALOutboundReceiptAdmission<TPrepared>;
    private readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
    private readonly work: ALWorkHandler;
    private readonly effects: ALOutboundMessageEffects<TPrepared>;
    private readonly removeStorageResetListener: (() => void) | undefined;
    private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
    private disposed = false;

    constructor(input: ALOutboundStoreLane.Input<TPrepared>) {
        this.input = input;
        const { stores, runtime } = input;
        this.readyPromise = stores.admissionStore.ready();
        const workPort = createALOutboundLaneWorkPort(input);
        const settlements: ALOutboundSettlementEmitter = (fact) => input.settlements(this.toStoreFact(fact));
        const admissions = createALOutboundLaneAdmissions(input, workPort, settlements);
        this.dispatchAdmission = admissions.dispatchAdmission;
        this.repairAdmission = admissions.repairAdmission;
        this.receiptAdmission = admissions.receiptAdmission;
        this.repairRetransmission = admissions.repairRetransmission;
        this.work = new ALWorkHandler({
            workerId: input.workerId,
            port: workPort,
            queueEngine: runtime.queueEngine,
            ownsQueueEngine: runtime.ownsQueueEngine,
            clock: runtime.clock,
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readNextReadyAtMs: (port) => readALOutboundWorkReadyAt(port, this.readNowMs(), this.readDequeueDeferral()),
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
            runClaim: (claim) => this.runOutboundClaim(claim),
            diagnostics: (event) => this.recordWorkDiagnostics(event)
        });
        this.effects = new ALOutboundMessageEffects({
            runtime,
            admissionStore: stores.admissionStore,
            dispatchAdmission: this.dispatchAdmission,
            commitDispatchPlan: (dispatch) => this.commit(dispatch),
            sendSignal: input.sendControls.signal,
            settlements
        });
        const { canonicalHandoff } = input;
        this.removeStorageResetListener = canonicalHandoff === undefined
            ? undefined
            : stores.storageResets?.add(() => canonicalHandoff.clear());
    }

    async ready(): Promise<void> {
        await this.readyPromise;
        await this.work.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.work.dispose();
        this.dispatchAdmission.dispose();
        this.removeStorageResetListener?.();
        this.input.canonicalHandoff?.clear();
    }

    /** A memory read on the volatile lane: whether this lane admitted the message. */
    async ownsMessage(msgId: string): Promise<boolean> {
        return await this.input.stores.admissionStore.hasSentMessageAdmission(msgId);
    }

    async commit(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.dispatchAdmission.commit(dispatch);
        this.setCanonicalHandoff(result);

        if (hasWrittenWork(result)) {
            this.work.committed(computeALOutboundWrittenDueByMs([result]));
        }

        return this.toStoreComputed(result.computed);
    }

    /** Members of one sender group may commit separately; results stay in dispatch order, with a wake after writes or before rethrow. */
    async commitAll(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly ALOutboundComputedDto<TPrepared>[]> {
        const results = await this.dispatchAdmission.commitAll(dispatches).catch((error) => {
            // A group rethrows only after every member ran, so members before the throw may have landed.
            this.work.committed(undefined);
            throw error;
        });
        results.forEach((result) => this.setCanonicalHandoff(result));
        if (results.some(hasWrittenWork)) {
            this.work.committed(computeALOutboundWrittenDueByMs(results));
        }
        return results.map((result) => this.toStoreComputed(result.computed));
    }

    /** Before the wake: the batch it starts claims what this commit wrote and finds its canonical row here. */
    private setCanonicalHandoff(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
        // A commit that resolves after dispose must not refill what dispose cleared.
        if (!this.disposed && result.committed && result.computed.bundle !== undefined) {
            this.input.canonicalHandoff?.setCommitted(result.computed.bundle, this.readNowMs());
        }
    }

    async acceptControlMessage(
        msg: ALMessage,
        source: ALOutboundControlSource
    ): Promise<ALOutboundControlAdmissionResult> {
        const admitted = await this.repairAdmission.acceptControlMessage(msg, source);
        // A foreign control and a rejected one write nothing, so they owe no batch.
        if (admitted.kind === 'committed' || admitted.kind === 'pending-control') {
            this.work.committed(undefined);
        }
        return admitted;
    }

    async acceptReceipt(control: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        return await this.receiptAdmission.admit(control);
    }

    /** A hand-over ends this lane's receipt of the message and states nothing (D56). */
    async endReceipt(msgId: string): Promise<void> {
        await this.repairAdmission.endReceipt(msgId);
    }

    /** What the admission states, as this lane's store holds it: nothing on the memory pair survives the document. */
    private toStoreComputed(computed: ALOutboundComputedDto<TPrepared>): ALOutboundComputedDto<TPrepared> {
        return { ...computed, verdict: this.toStoreVerdict(computed.verdict) };
    }

    private toStoreFact(fact: ALOutboundSettlementFact): ALOutboundSettlementFact {
        return fact.kind === 'admission' ? { ...fact, verdict: this.toStoreVerdict(fact.verdict) } : fact;
    }

    private toStoreVerdict(verdict: ALDeliveryAdmissionVerdict): ALDeliveryAdmissionVerdict {
        return verdict.kind === 'admitted' && this.input.lane === 'volatile'
            ? { ...verdict, durable: false }
            : verdict;
    }

    /** The outbound owner reserves straight from the queue, so it reads no page and observes no row's wait. */
    private async selectOutboundWork(
        port: ALWorkQueuePort,
        pageSize: number
    ): Promise<ALWorkReadySelection> {
        this.evictWhenDue();
        const startedAtMs = this.readNowMs();
        const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
        return {
            claims,
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: Math.max(0, this.readNowMs() - startedAtMs),
            earliestDueAtMs: undefined
        };
    }

    /** The memory pair has no eviction loop of its own: its round sweeps it, at most once per interval. */
    private evictWhenDue(): void {
        const nowMs = this.readNowMs();
        if (this.input.evictExpired === undefined || nowMs < this.nextEvictionAtMs) {
            return;
        }
        this.nextEvictionAtMs = nowMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS;
        this.input.evictExpired();
    }

    /** An open dequeue circuit must not advertise its rows, or every batch claims and releases them. */
    private readDequeueDeferral(): ALOutboundDequeueDeferral {
        const { resilience } = this.input.runtime.dequeue;
        return {
            types: this.input.dequeueTypes,
            readyAtMs: resilience.isNotAllowedThroughToDequeue()
                ? this.readNowMs() + resilience.toCircuitOpenBackoffMs()
                : undefined
        };
    }

    private async runOutboundClaim(claim: ALWorkClaim): Promise<ALWorkAttemptResult> {
        try {
            const work = await this.readExpirableOutboundWork(claim.entry);
            return work === undefined ? { status: 'completed' } : await this.runDurableEffect(work);
        }
        catch (error) {
            // A planner that is still waiting for authority owes no attempt: reschedule, never charge it.
            if (error instanceof Error && isNotReadyException(error)) {
                return { status: 'not-ready', readyAtMs: this.readNowMs() + error.delayMs };
            }
            throw error;
        }
    }

    /** A deadline crossed during the read is expiry, not a defect: the work is dropped, not rejected. */
    private async readExpirableOutboundWork(
        entry: ResourceEntry
    ): Promise<ALOutboundEffectSnapshot<TPrepared> | undefined> {
        try {
            return await this.readOutboundWork(entry);
        }
        catch (error) {
            if (this.hasReachedDeadline(entry)) {
                return undefined;
            }
            throw error;
        }
    }

    private hasReachedDeadline(entry: ResourceEntry): boolean {
        return entry.audit.expiryTs.epochMilliseconds <= this.readNowMs();
    }

    private async readOutboundWork(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
        return this.input.dequeueTypes.has(entry.typeId)
            ? toALOutboundDequeueWork(entry, this.input.runtime.readMessageFromEntry)
            : await this.input.stores.admissionStore.readWorkSnapshot(
                entry,
                this.input.canonicalHandoff?.takeCanonical(entry.key, this.readNowMs())
            );
    }

    private async runDurableEffect(
        effect: ALOutboundEffectSnapshot<TPrepared>
    ): Promise<ALWorkAttemptResult> {
        // Before anything else: a cancelled or handed-over message's remaining work completes silently, of any kind --
        // no `attempt-started`, no `expired`, no repair. A live attempt already past `attempt-started`
        // still terminates its own `attempt-settled cancelled` -- stated by the effects layer if the
        // abort lands before the carrier runs, or by the carrier's own settlement if it lands during it.
        if (this.isEndedEffect(effect)) {
            return { status: 'completed' };
        }
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            this.emitWorkExpiry(effect);
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                return await this.effects.admitPendingMessage(effect);
            case 'dequeue-message':
                return await this.effects.admitDequeuedMessage(effect);
            case 'admit-control':
                return await this.repairAdmission.replayControlAdmission(effect.payload);
            case 'send-prepared':
                return await this.runPreparedSend(effect, effect.payload);
            case 'ack-timeout':
                await this.repairAdmission.retryPendingAck(effect.payload.msgId);
                return { status: 'completed' };
            case 'repair-hint':
                await this.repairRetransmission.retransmitFromRepairHint(
                    effect.payload.msgId,
                    effect.payload.request,
                    effect.effectId
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.repairRetransmission.retransmitByMsgId(effect.payload.msgId, {
                    attemptIdentity: effect.effectId
                });
                return { status: 'completed' };
        }
    }

    private isEndedEffect(effect: ALOutboundEffectSnapshot<TPrepared>): boolean {
        const msgId = resolveALOutboundEffectMsgId(effect);
        return msgId !== undefined && this.input.sendControls.isEnded(msgId);
    }

    /** One attempt on one prepared copy: the attempt is stated before its carrier can settle it. */
    private async runPreparedSend(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>
    ): Promise<ALWorkAttemptResult> {
        const canonicalMessage = effect.canonicalMessage;
        if (!canonicalMessage) {
            throw new NonRetryableException('Prepared work has no canonical message');
        }
        const msgId = canonicalMessage.id.msgId;
        const { sendControls } = this.input;
        const signal = sendControls.acquire(msgId);
        this.input.settlements({
            kind: 'attempt-started',
            msgId,
            attemptId: effect.effectId
        });
        try {
            const result = await this.effects.writePreparedMessage({
                attemptId: effect.effectId,
                payload,
                lifecycle: {
                    canonicalMessage,
                    signal,
                    expiresAtMs: effect.expireAtTimestamp,
                    leaseUntilMs: effect.leaseUntilMs
                },
                attempts: effect.attempts
            });
            sendControls.releaseWhenSettled(msgId, result);
            return result;
        }
        catch (error) {
            sendControls.release(msgId);
            throw error;
        }
    }

    /**
     * Only a row whose own deadline *is* the message deadline may call the message expired. A
     * `send-prepared` or `admit-message` row carries the message's `expiresAtMs` as its queue
     * expiry, and a foreign dequeue row is stamped from the same deadline; every other kind expires
     * on a budget of its own -- an `ack-timeout` on the receipt's retry windows, a `nack-retry` on
     * its schedule -- and says nothing about the message.
     */
    private emitWorkExpiry(effect: ALOutboundEffectSnapshot<TPrepared>): void {
        const msgId = effect.canonicalMessage?.id.msgId;
        if (msgId === undefined || !statesMessageDeadline(effect.payload.kind)) {
            return;
        }
        this.input.settlements({
            kind: 'expired',
            msgId,
            detail: 'Outbound work reached the message deadline before its attempt ran.'
        });
    }

    /**
     * A probe is reported as it happens rather than folded into the batch: a batch that runs is one
     * of six reasons a probe read storage, and only the reason separates an owner re-reading because
     * it committed from one re-reading because another writer woke every owner on the engine.
     */
    private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
        const { diagnostics } = this.input.runtime;
        if (event.kind === 'readiness-probe') {
            diagnostics?.({
                kind: 'readiness-probe',
                lane: this.input.lane,
                workerId: event.workerId,
                cause: event.cause,
                readyAtMs: event.readyAtMs,
                durationMs: event.durationMs
            });
            return;
        }
        diagnostics?.({
            kind: 'effect-drain',
            lane: this.input.lane,
            workerId: event.workerId,
            durationMs: event.durationMs,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount
        });
    }

    private readNowMs(): number {
        return this.input.runtime.clock.nowMs();
    }
}

/** The admissions one lane runs over its own store pair and work port. */
interface ALOutboundLaneAdmissions<TPrepared> {
    readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    readonly receiptAdmission: ALOutboundReceiptAdmission<TPrepared>;
    readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
}

/** The lane's own work types, plus the foreign dequeue rows only the durable lane admits. */
function createALOutboundLaneWorkPort<TPrepared>(input: ALOutboundStoreLane.Input<TPrepared>): ALWorkQueuePort {
    const { stores, runtime } = input;
    return createALWorkQueuePort({
        queue: stores.workQueue,
        workTypes: new Set([toALOutboundWorkType(stores.admissionStore.namespace), ...input.dequeueTypes]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: () => runtime.clock.nowMs(),
        random: runtime.random
    });
}

function createALOutboundLaneAdmissions<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    workPort: ALWorkQueuePort,
    settlements: ALOutboundSettlementEmitter
): ALOutboundLaneAdmissions<TPrepared> {
    const { stores, runtime } = input;
    const dispatchAdmission = new ALOutboundDispatchAdmission({
        lane: input.lane,
        admissionStore: stores.admissionStore,
        workPort,
        toOutboxEntry: runtime.toOutboxEntry,
        decodePreparedMessage: runtime.decodePreparedMessage,
        clock: runtime.clock,
        browserLocks: input.browserLocks,
        diagnostics: runtime.diagnostics,
        settlements
    });
    return {
        dispatchAdmission,
        repairAdmission: createALOutboundLaneRepairAdmission(input, workPort, settlements),
        receiptAdmission: new ALOutboundReceiptAdmission({
            admissionStore: stores.admissionStore,
            clock: runtime.clock,
            settlements,
            diagnostics: runtime.diagnostics
        }),
        repairRetransmission: new ALOutboundRepairRetransmission({
            admissionStore: stores.admissionStore,
            dispatchAdmission,
            planOutgoingMessage: runtime.planOutgoingMessage,
            planRepairMessage: runtime.planRepairMessage
        })
    };
}

/** Controls commit through the lane's own control admission, over its own work port. */
function createALOutboundLaneRepairAdmission<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    workPort: ALWorkQueuePort,
    settlements: ALOutboundSettlementEmitter
): ALOutboundRepairAdmission<TPrepared> {
    const { stores, runtime } = input;
    return new ALOutboundRepairAdmission({
        admissionStore: stores.admissionStore,
        controlAdmission: stores.admissionStore.createControlAdmission({
            port: workPort,
            clock: runtime.clock,
            settlements,
            carrier: runtime.carrier
        }),
        clock: runtime.clock,
        planOutgoingMessage: runtime.planOutgoingMessage,
        planRepairMessage: runtime.planRepairMessage,
        diagnostics: runtime.diagnostics,
        settlements
    });
}

function hasWrittenWork<TPrepared>(result: ALOutboundDispatchAdmission.Result<TPrepared>): boolean {
    return result.committed || result.computed.verdict.kind === 'pending';
}

/**
 * When the last work row these commits wrote becomes claimable, or undefined when one of them wrote
 * work its result does not describe: a receipted send's acknowledgement timeout is due after its
 * send, so the batch that sends it cannot have claimed it.
 */
function computeALOutboundWrittenDueByMs<TPrepared>(
    results: readonly ALOutboundDispatchAdmission.Result<TPrepared>[]
): number | undefined {
    let writtenDueByMs = 0;
    for (const result of results.filter(hasWrittenWork)) {
        const effects = result.committed ? result.computed.bundle?.durableEffects : undefined;
        if (effects === undefined) {
            return undefined;
        }
        for (const { retryAtMs } of effects) {
            if (retryAtMs === undefined) {
                return undefined;
            }
            writtenDueByMs = Math.max(writtenDueByMs, retryAtMs);
        }
    }
    return writtenDueByMs;
}

/** The effect kinds whose queue row expires exactly when the message it carries does. */
function statesMessageDeadline<TPrepared>(kind: ALOutboundDurableEffect<TPrepared>['kind']): boolean {
    return kind === 'send-prepared' || kind === 'admit-message' || kind === 'dequeue-message';
}

/** The message a durable effect names, read from whichever field its own kind carries the id in. */
function resolveALOutboundEffectMsgId<TPrepared>(
    effect: ALOutboundEffectSnapshot<TPrepared>
): string | undefined {
    const { payload } = effect;
    switch (payload.kind) {
        case 'admit-message':
        case 'send-prepared':
            return payload.message.msgId;
        case 'ack-timeout':
        case 'repair-hint':
        case 'nack-retry':
            return payload.msgId;
        case 'admit-control':
            return payload.msg.id.msgId;
        case 'dequeue-message':
            return effect.canonicalMessage?.id.msgId;
    }
    // `noImplicitReturns` is off: without this, a payload kind missing a case above would compile
    // silently and fall through returning `undefined`, escaping cancellation instead of failing the build.
    // The switch narrows `payload` itself exhaustively, not `payload.kind` -- assign `payload` here.
    const exhaustivePayload: never = payload;
    return exhaustivePayload;
}
