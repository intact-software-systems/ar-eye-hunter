import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs } from '../../../al-contracts/al-policy.ts';
import type { ALPublicationPolicy } from '../../../al-contracts/publication/al-publication-policy.ts';
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
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';
import type { ALOutboundStagedPublication } from './al-outbound-staged-publication.ts';
import { computeALPublicationSelection } from './compute-al-publication-selection.ts';

export interface ALOutboundPublicationLaneReport {
    readonly laneKey: string;
    readonly policy: ALPublicationPolicy;
    /** Undefined for an idle lane: the next value staged on it opens an opportunity at once. */
    readonly nextOpportunityAtMs: number | undefined;
    readonly staged: number;
    readonly streams: number;
}

const DISPOSED_VERDICT: ALDeliveryAdmissionVerdict = {
    kind: 'skipped',
    reason: 'disposed',
    detail: 'The publication stage is disposed.'
};

/** One live channel's staged values: `streams` keeps first-staged order, and each stream holds its values oldest first. */
interface ALOutboundPublicationLane<TContext> {
    readonly laneKey: string;
    readonly policy: ALPublicationPolicy;
    readonly streams: Map<string, readonly ALOutboundStagedPublication<TContext>[]>;
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
        /** The caller settles the refusal: the stage never opened the value. */
        | Readonly<{ kind: 'refused'; reason: 'oversized'; detail: string; }>;
}

/**
 * Paces live publications before admission (D469, D470): it holds the newest values of each stream per lane and
 * hands each lane's selection to `submit` at that lane's opportunities. It never sends and never admits.
 */
export class ALOutboundPublicationStage<TContext> {
    private readonly input: ALOutboundPublicationStage.Input<TContext>;
    private readonly lanes = new Map<string, ALOutboundPublicationLane<TContext>>();
    private disposed = false;

    constructor(input: ALOutboundPublicationStage.Input<TContext>) {
        this.input = input;
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
     * expired one would displace a live value of its stream and then expire at the boundary.
     */
    stage(input: ALOutboundPublicationStage.StageInput<TContext>): ALOutboundPublicationStage.StageResult {
        this.assertStageOpen();
        const laneKey = toALPublicationLaneKey(input.msg);
        const lane = this.lanes.get(laneKey) ?? createIdleLane<TContext>(laneKey, input.policy);
        if (input.bytes > lane.policy.drain.bytes) {
            return {
                kind: 'refused',
                reason: 'oversized',
                detail: `A live value of ${input.bytes} bytes exceeds the drain budget of ${lane.policy.drain.bytes}.`
            };
        }
        this.lanes.set(laneKey, lane);
        const publication = toStagedPublication(input, laneKey, this.input.clock.nowMs());
        this.input.settle(toStagedSettlement(publication));
        const displaced = this.retain(lane, publication);
        if (lane.nextOpportunityAtMs === undefined) {
            this.scheduleLane(lane, publication.stagedAtMs);
            this.input.queueEngine.wake();
        }
        return { kind: 'staged', displacedMsgId: displaced?.msgId };
    }

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

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.input.queueEngine.excludeTask(this.input.taskId);
        const atMs = this.input.clock.nowMs();
        const staged = [...this.lanes.values()].flatMap((lane) => [...lane.streams.values()].flat());
        this.lanes.clear();
        staged.forEach((publication) => this.settleAdmission(publication, atMs, DISPOSED_VERDICT));
    }

    private retain(
        lane: ALOutboundPublicationLane<TContext>,
        publication: ALOutboundStagedPublication<TContext>
    ): ALOutboundStagedPublication<TContext> | undefined {
        const staged = [...(lane.streams.get(publication.streamKey) ?? []), publication];
        const { retained, displaced } = retainNewest(staged, lane.policy.retainNewest);
        lane.streams.set(publication.streamKey, retained);
        displaced.forEach((value) =>
            this.input.settle({
                kind: 'superseded',
                msgId: value.msgId,
                carrier: value.carrier,
                atMs: publication.stagedAtMs,
                replacementMsgId: publication.msgId,
                detail: 'A newer live value of the stream displaced it before its opportunity.',
                traceId: publication.traceId
            })
        );
        return displaced[0];
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
            nowMs: atMs
        });
        streamKeys.forEach((streamKey, index) => setStreamValues(lane, streamKey, selection.remaining[index] ?? []));
        selection.expired.forEach((publication) => this.settleExpired(publication, atMs));
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
            deferred: selection.remaining.reduce((count, stream) => count + stream.length, 0),
            expired: selection.expired.length,
            bytes: selection.selected.reduce((bytes, publication) => bytes + publication.bytes, 0)
        });
    }

    private async submitSelected(selected: readonly ALOutboundStagedPublication<TContext>[]): Promise<void> {
        if (selected.length === 0) {
            return;
        }
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
    return { laneKey, policy, streams: new Map(), lastOpportunityAtMs: undefined, nextOpportunityAtMs: undefined };
}

function isLaneDue<TContext>(lane: ALOutboundPublicationLane<TContext>, nowMs: number): boolean {
    return lane.nextOpportunityAtMs !== undefined && lane.nextOpportunityAtMs <= nowMs;
}

function setStreamValues<TContext>(
    lane: ALOutboundPublicationLane<TContext>,
    streamKey: string,
    values: readonly ALOutboundStagedPublication<TContext>[]
): void {
    if (values.length === 0) {
        lane.streams.delete(streamKey);
        return;
    }
    lane.streams.set(streamKey, values);
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
