import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { ALPublicationPolicy } from '../../../al-contracts/publication/al-publication-policy.ts';
import type {
    ALPublicationStageLimit,
    ALPublicationStageLimits
} from '../../../al-contracts/publication/al-publication-stage-limits.ts';
import {
    toALPublicationLaneKey,
    toALPublicationStreamKey
} from '../../../al-contracts/publication/to-al-publication-stream-key.ts';
import { retainNewest } from '../../../cache/retain-newest.ts';
import { computeNextCadenceAtMs } from '../../../resilience/cadence.ts';
import { toError } from '../../../resilience/to-error.ts';
import type { InboxOutboxEngine } from '../../../services/inbox-outbox-engine.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryCarrier,
    ALDeliverySettlement,
    ALDeliverySettlementSink
} from '../../delivery/al-delivery-lifecycle.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundMessageRuntime,
    type ALOutboundRuntimeDiagnosticsEvent,
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';
import {
    ALOutboundPublicationLedger,
    toIdleALOutboundPublicationLedgerReport,
    type ALOutboundPublicationLedgerReport
} from './al-outbound-publication-ledger.ts';
import type { ALOutboundStagedPublication } from './al-outbound-staged-publication.ts';
import {
    computeALPublicationReconfiguration,
    isSameALPublicationPolicy,
    type ALPublicationSupersession
} from './compute-al-publication-reconfiguration.ts';
import { computeALPublicationSelection } from './compute-al-publication-selection.ts';

export interface ALOutboundPublicationLaneReport {
    readonly laneKey: string;
    readonly policy: ALPublicationPolicy;
    /** Undefined for an idle lane: the next value staged on it opens an opportunity at once. */
    readonly nextOpportunityAtMs: number | undefined;
    readonly staged: number;
    readonly streams: number;
}

export interface ALOutboundPublicationStageReport extends ALOutboundPublicationLedgerReport {
    readonly lanes: number;
}

/** What a stage under `limits` reports before it holds or settled anything: a connect that staged no live value yet. */
export function toIdleALOutboundPublicationStageReport(
    limits: ALPublicationStageLimits
): ALOutboundPublicationStageReport {
    return { lanes: 0, ...toIdleALOutboundPublicationLedgerReport(limits) };
}

/** One value's outcome on the stage, with a capacity refusal's limit, as its `publication-staging` event states it. */
type ALPublicationStagingFact = Pick<
    Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'publication-staging'; }>,
    'outcome' | 'limit'
>;

const NEWER_VALUE_DETAIL = 'A newer live value of the stream displaced it before its opportunity.';
const SHRUNK_RETENTION_DETAIL = 'The live channel\'s retention shrank, and newer values of the stream displaced it.';

const DISPOSED_VERDICT: ALDeliveryAdmissionVerdict = {
    kind: 'skipped',
    reason: 'disposed',
    detail: 'The publication stage is disposed.'
};

/**
 * One live channel's staged values: `streams` keeps first-staged order, and each stream holds its values oldest
 * first. `cursor` is the index in `streams` of the stream the next opportunity serves first (D478).
 */
interface ALOutboundPublicationLane<TContext> {
    readonly laneKey: string;
    policy: ALPublicationPolicy;
    readonly streams: Map<string, readonly ALOutboundStagedPublication<TContext>[]>;
    cursor: number;
    lastOpportunityAtMs: number | undefined;
    nextOpportunityAtMs: number | undefined;
}

export namespace ALOutboundPublicationStage {
    export interface Input<TContext> {
        readonly taskId: string;
        readonly queueEngine: InboxOutboxEngine;
        /** The epoch-millisecond integer clock `queueEngine` schedules by: lanes are due and handed to `wakeAt` on it. */
        readonly clock: ALOutboundMessageRuntime.Clock;
        /**
         * Admits the values one opportunity selected. It rejects only when it admitted none of them, and the stage then
         * settles each `failed`; once a value enters admission, its carrier settles that value's outcome.
         */
        readonly submit: (selected: readonly ALOutboundStagedPublication<TContext>[]) => Promise<void>;
        readonly settle: ALDeliverySettlementSink;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
        /** What the stage holds at once across its lanes (D477). */
        readonly limits: ALPublicationStageLimits;
    }

    export interface StageInput<TContext> {
        readonly msg: ALMessage;
        readonly carrier: ALDeliveryCarrier;
        readonly policy: ALPublicationPolicy;
        readonly bytes: number;
        readonly context: TContext;
    }

    export type StageResult =
        | Readonly<{ kind: 'staged'; displacedMsgId: string | undefined; }>
        /** The caller settles a refusal as the value's admission verdict: the stage never opened the value. */
        | Readonly<{ kind: 'refused'; reason: 'oversized'; detail: string; }>
        | Readonly<{ kind: 'refused'; reason: 'capacity'; limit: ALPublicationStageLimit; detail: string; }>;
}

/**
 * Paces live publications before admission (D469, D470): it holds the newest values of each stream per lane and
 * hands each lane's selection to `submit` at that lane's opportunities. It never sends and never admits.
 */
export class ALOutboundPublicationStage<TContext> {
    private readonly input: ALOutboundPublicationStage.Input<TContext>;
    private readonly lanes = new Map<string, ALOutboundPublicationLane<TContext>>();
    private readonly ledger: ALOutboundPublicationLedger;
    private disposed = false;

    constructor(input: ALOutboundPublicationStage.Input<TContext>) {
        this.input = input;
        this.ledger = new ALOutboundPublicationLedger(input.limits);
        input.queueEngine.includeTask(input.taskId, {
            name: input.taskId,
            maxConcurrency: () => 1,
            isWork: () => this.hasDueLane(this.input.clock.nowMs()),
            runnable: () => this.runDueOpportunities(),
            ongoingTasks: []
        });
    }

    /**
     * The caller stages only a value whose deadline is still ahead, as its admission refusal guarantees (D471): an
     * expired one would displace a live value of its stream and then expire at the boundary. The ledger reads the
     * stream as retention would leave it, so a value that displaces the oldest of its stream frees that one's share.
     */
    stage(input: ALOutboundPublicationStage.StageInput<TContext>): ALOutboundPublicationStage.StageResult {
        this.assertStageOpen();
        const laneKey = toALPublicationLaneKey(input.msg);
        const lane = this.lanes.get(laneKey) ?? createIdleLane<TContext>(laneKey, input.policy);
        this.reconfigureLane(lane, input.policy);
        const publication = toStagedPublication(input, laneKey, this.input.clock.nowMs());
        const previous = lane.streams.get(publication.streamKey) ?? [];
        const { retained, displaced } = retainNewest([...previous, publication], lane.policy.retainNewest);
        const refusal = resolveStageRefusal(
            lane,
            publication,
            this.ledger.resolveRefusal({ previous, next: retained })
        );
        if (refusal !== undefined) {
            this.recordOutcome(publication, publication.stagedAtMs, toRefusedOutcome(refusal));
            return refusal;
        }
        this.lanes.set(laneKey, lane);
        this.writeStream(lane, publication.streamKey, retained);
        this.recordOutcome(publication, publication.stagedAtMs, { outcome: 'staged' });
        this.input.settle(toStagedSettlement(publication));
        this.settleSuperseded(
            displaced.map((value) => ({ displaced: value, replacement: publication })),
            publication.stagedAtMs,
            NEWER_VALUE_DETAIL
        );
        if (lane.nextOpportunityAtMs === undefined) {
            this.scheduleLane(lane, publication.stagedAtMs);
            this.input.queueEngine.wake();
        }
        return { kind: 'staged', displacedMsgId: displaced[0]?.msgId };
    }

    /** One lane's schedule and holdings; only the tests read it, and the usage report reads `readReport`. */
    readLane(laneKey: string): ALOutboundPublicationLaneReport | undefined {
        const lane = this.lanes.get(laneKey);
        if (lane === undefined) {
            return undefined;
        }
        const streams = [...lane.streams.values()];
        return {
            laneKey,
            policy: lane.policy,
            nextOpportunityAtMs: lane.nextOpportunityAtMs,
            staged: streams.reduce((count, stream) => count + stream.length, 0),
            streams: streams.length
        };
    }

    /** Settles a value the stage still holds `cancelled`; a value an opportunity selected is its carrier's to cancel. */
    cancel(msgId: string): boolean {
        const found = findStagedPublication(this.lanes.values(), msgId);
        if (found === undefined) {
            return false;
        }
        const { lane, publication } = found;
        const stream = lane.streams.get(publication.streamKey) ?? [];
        this.writeStream(lane, publication.streamKey, stream.filter((value) => value.msgId !== msgId));
        const atMs = this.input.clock.nowMs();
        this.recordOutcome(publication, atMs, { outcome: 'cancelled' });
        this.input.settle({
            kind: 'cancelled',
            msgId,
            carrier: publication.carrier,
            atMs,
            traceId: publication.traceId
        });
        return true;
    }

    readReport(): ALOutboundPublicationStageReport {
        return { lanes: this.lanes.size, ...this.ledger.readReport() };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.input.queueEngine.excludeTask(this.input.taskId);
        const atMs = this.input.clock.nowMs();
        const staged = [...this.lanes.values()].flatMap((lane) => [...lane.streams.values()].flat());
        this.lanes.forEach((lane) =>
            [...lane.streams.keys()].forEach((streamKey) => this.writeStream(lane, streamKey, []))
        );
        this.lanes.clear();
        staged.forEach((publication) => this.settleAdmission(publication, atMs, DISPOSED_VERDICT));
    }

    /**
     * The one write of a stream's values, so the ledger's totals are always the streams' contents. Removing a stream
     * before the cursor moves the cursor with it, so it still names the stream it named.
     */
    private writeStream(
        lane: ALOutboundPublicationLane<TContext>,
        streamKey: string,
        values: readonly ALOutboundStagedPublication<TContext>[]
    ): void {
        this.ledger.recordStreamChange({ previous: lane.streams.get(streamKey) ?? [], next: values });
        if (values.length > 0) {
            lane.streams.set(streamKey, values);
            return;
        }
        const index = [...lane.streams.keys()].indexOf(streamKey);
        if (index !== -1 && index < lane.cursor) {
            lane.cursor -= 1;
        }
        lane.streams.delete(streamKey);
    }

    /** A send whose policy differs from its lane's reconfigures the lane before its value is staged (D479). */
    private reconfigureLane(lane: ALOutboundPublicationLane<TContext>, policy: ALPublicationPolicy): void {
        if (isSameALPublicationPolicy(lane.policy, policy)) {
            return;
        }
        const atMs = this.input.clock.nowMs();
        const streamKeys = [...lane.streams.keys()];
        const reconfiguration = computeALPublicationReconfiguration({
            streams: [...lane.streams.values()],
            policy,
            lastOpportunityAtMs: lane.lastOpportunityAtMs,
            nextOpportunityAtMs: lane.nextOpportunityAtMs,
            nowMs: atMs
        });
        lane.policy = policy;
        lane.nextOpportunityAtMs = reconfiguration.nextOpportunityAtMs;
        streamKeys.forEach((streamKey, index) =>
            this.writeStream(lane, streamKey, reconfiguration.remaining[index] ?? [])
        );
        this.settleSuperseded(reconfiguration.superseded, atMs, SHRUNK_RETENTION_DETAIL);
        reconfiguration.oversized.forEach((publication) => {
            this.recordOutcome(publication, atMs, { outcome: 'refused' });
            this.settleAdmission(publication, atMs, {
                kind: 'refused',
                reason: 'oversized',
                detail: toOversizedDetail(publication.bytes, policy.drain.bytes)
            });
        });
        this.wakeAtNextOpportunity();
    }

    private settleSuperseded(
        supersessions: readonly ALPublicationSupersession<ALOutboundStagedPublication<TContext>>[],
        atMs: number,
        detail: string
    ): void {
        supersessions.forEach(({ displaced, replacement }) => {
            this.recordOutcome(displaced, atMs, { outcome: 'superseded' });
            this.input.settle({
                kind: 'superseded',
                msgId: displaced.msgId,
                carrier: displaced.carrier,
                atMs,
                replacementMsgId: replacement.msgId,
                detail,
                traceId: replacement.traceId
            });
        });
    }

    /** Counts one value's outcome and states it as a payload-free diagnostic, under the value's own trace (D480). */
    private recordOutcome(
        publication: ALOutboundStagedPublication<TContext>,
        atMs: number,
        outcome: ALPublicationStagingFact
    ): void {
        this.ledger.count(outcome.outcome, 1);
        writeALOutboundRuntimeDiagnostic(this.input.diagnostics, {
            kind: 'publication-staging',
            laneKey: publication.laneKey,
            msgId: publication.msgId,
            traceId: publication.traceId,
            atMs,
            ...outcome
        });
    }

    /** Its owner drops a disposed stage in the same synchronous step, so a later stage() is a wiring defect. */
    private assertStageOpen(): void {
        if (this.disposed) {
            throw new Error('The publication stage is disposed.');
        }
    }

    private hasDueLane(nowMs: number): boolean {
        return [...this.lanes.values()].some((lane) => isLaneDue(lane, nowMs));
    }

    private async runDueOpportunities(): Promise<void> {
        const dueLanes = [...this.lanes.values()].filter((lane) => isLaneDue(lane, this.input.clock.nowMs()));
        for (const lane of dueLanes) {
            if (this.disposed) {
                return;
            }
            await this.runOpportunity(lane);
        }
        if (this.disposed) {
            return;
        }
        this.wakeAtNextOpportunity();
    }

    private wakeAtNextOpportunity(): void {
        const nextOpportunities = [...this.lanes.values()].flatMap((lane) => lane.nextOpportunityAtMs ?? []);
        this.input.queueEngine.wakeAt(
            this.input.taskId,
            nextOpportunities.length === 0 ? undefined : Math.min(...nextOpportunities)
        );
    }

    /** A lane its last opportunity emptied stays scheduled for one more boundary, so a value staged meanwhile waits. */
    private async runOpportunity(lane: ALOutboundPublicationLane<TContext>): Promise<void> {
        if (lane.streams.size === 0) {
            lane.nextOpportunityAtMs = undefined;
            return;
        }
        const atMs = this.input.clock.nowMs();
        const streamKeys = [...lane.streams.keys()];
        const selection = computeALPublicationSelection({
            streams: [...lane.streams.values()],
            drain: lane.policy.drain,
            nowMs: atMs,
            startIndex: lane.cursor
        });
        lane.cursor = selection.nextStartIndex;
        streamKeys.forEach((streamKey, index) => this.writeStream(lane, streamKey, selection.remaining[index] ?? []));
        selection.expired.forEach((publication) => this.settleExpired(publication, atMs));
        const deferred = selection.remaining.reduce((count, stream) => count + stream.length, 0);
        this.ledger.count('deferred', deferred);
        lane.lastOpportunityAtMs = atMs;
        this.scheduleLane(lane, atMs);
        await this.submitSelected(selection.selected);
        if (this.disposed) {
            return;
        }
        writeALOutboundRuntimeDiagnostic(this.input.diagnostics, {
            kind: 'publication-opportunity',
            laneKey: lane.laneKey,
            atMs,
            selected: selection.selected.length,
            deferred,
            expired: selection.expired.length,
            bytes: selection.selected.reduce((bytes, publication) => bytes + publication.bytes, 0)
        });
    }

    private async submitSelected(selected: readonly ALOutboundStagedPublication<TContext>[]): Promise<void> {
        if (selected.length === 0) {
            return;
        }
        this.ledger.count('admitted', selected.length);
        try {
            await this.input.submit(selected);
        }
        catch (error) {
            const atMs = this.input.clock.nowMs();
            const verdict: ALDeliveryAdmissionVerdict = { kind: 'failed', detail: toError(error).message };
            selected.forEach((publication) => this.settleAdmission(publication, atMs, verdict));
        }
    }

    private scheduleLane(lane: ALOutboundPublicationLane<TContext>, nowMs: number): void {
        lane.nextOpportunityAtMs = computeNextCadenceAtMs({
            lastAtMs: lane.lastOpportunityAtMs,
            cadenceMs: lane.policy.cadenceMs,
            nowMs
        });
    }

    private settleExpired(publication: ALOutboundStagedPublication<TContext>, atMs: number): void {
        this.recordOutcome(publication, atMs, { outcome: 'expired' });
        this.input.settle({
            kind: 'expired',
            msgId: publication.msgId,
            carrier: publication.carrier,
            atMs,
            detail: 'The deadline passed while the value was staged.',
            traceId: publication.traceId
        });
    }

    private settleAdmission(
        publication: ALOutboundStagedPublication<TContext>,
        atMs: number,
        verdict: ALDeliveryAdmissionVerdict
    ): void {
        this.input.settle({
            kind: 'admission',
            msgId: publication.msgId,
            carrier: publication.carrier,
            atMs,
            verdict,
            trackedReceiptAlgo: 'none',
            traceId: publication.traceId
        });
    }
}

function createIdleLane<TContext>(laneKey: string, policy: ALPublicationPolicy): ALOutboundPublicationLane<TContext> {
    return {
        laneKey,
        policy,
        streams: new Map(),
        cursor: 0,
        lastOpportunityAtMs: undefined,
        nextOpportunityAtMs: undefined
    };
}

function isLaneDue<TContext>(lane: ALOutboundPublicationLane<TContext>, nowMs: number): boolean {
    return lane.nextOpportunityAtMs !== undefined && lane.nextOpportunityAtMs <= nowMs;
}

/** The drain budget bounds one value before the ledger's limits do: a value no opportunity could select is oversized. */
function resolveStageRefusal<TContext>(
    lane: ALOutboundPublicationLane<TContext>,
    publication: ALOutboundStagedPublication<TContext>,
    ledgerRefusal: ALOutboundPublicationLedger.Refusal | undefined
): Extract<ALOutboundPublicationStage.StageResult, { kind: 'refused'; }> | undefined {
    if (publication.bytes > lane.policy.drain.bytes) {
        return {
            kind: 'refused',
            reason: 'oversized',
            detail: toOversizedDetail(publication.bytes, lane.policy.drain.bytes)
        };
    }
    return ledgerRefusal === undefined ? undefined : { kind: 'refused', reason: 'capacity', ...ledgerRefusal };
}

function toRefusedOutcome(
    refusal: Extract<ALOutboundPublicationStage.StageResult, { kind: 'refused'; }>
): ALPublicationStagingFact {
    return refusal.reason === 'capacity' ? { outcome: 'refused', limit: refusal.limit } : { outcome: 'refused' };
}

function toOversizedDetail(bytes: number, drainBytes: number): string {
    return `A live value of ${bytes} bytes exceeds the drain budget of ${drainBytes}.`;
}

function findStagedPublication<TContext>(
    lanes: Iterable<ALOutboundPublicationLane<TContext>>,
    msgId: string
): { lane: ALOutboundPublicationLane<TContext>; publication: ALOutboundStagedPublication<TContext>; } | undefined {
    for (const lane of lanes) {
        const publication = [...lane.streams.values()].flat().find((value) => value.msgId === msgId);
        if (publication !== undefined) {
            return { lane, publication };
        }
    }
    return undefined;
}

/** A message without a deadline never expires on the stage, as admission reads it. */
function toStagedPublication<TContext>(
    input: ALOutboundPublicationStage.StageInput<TContext>,
    laneKey: string,
    stagedAtMs: number
): ALOutboundStagedPublication<TContext> {
    return {
        msg: input.msg,
        msgId: input.msg.id.msgId,
        traceId: input.msg.id.traceId,
        carrier: input.carrier,
        laneKey,
        streamKey: toALPublicationStreamKey(input.msg),
        bytes: input.bytes,
        expiresAtMs: resolveALMessageExpireAtMs(input.msg) ?? Number.POSITIVE_INFINITY,
        stagedAtMs,
        context: input.context
    };
}

function toStagedSettlement<TContext>(publication: ALOutboundStagedPublication<TContext>): ALDeliverySettlement {
    return {
        kind: 'staged',
        msgId: publication.msgId,
        carrier: publication.carrier,
        atMs: publication.stagedAtMs,
        traceId: publication.traceId
    };
}
