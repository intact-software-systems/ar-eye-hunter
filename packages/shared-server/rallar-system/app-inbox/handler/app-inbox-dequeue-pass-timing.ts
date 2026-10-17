import { EnqueuedType } from '@shared/api/api-config.ts';
import { Reservator, type DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueMessageReader } from '@shared/services/queue-message-reader.ts';

import type { PSqlExecutorCounters, PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { recordRallarTiming, type RallarTimingDetails, type RallarTimingSink } from '../../observability/timing.ts';
import { validateAppInboxCommandIdentity } from '../app-inbox-command-identity.ts';
import { toAppInboxAttemptTimingDetails } from './app-inbox-attempt-timing.ts';
import { toExecutorCounterDeltaDetails } from './app-inbox-phase-timing.ts';

interface ExecutorSample {
    readonly atMs: number;
    readonly counters: PSqlExecutorCounters | undefined;
}

interface ExecutorSpan {
    readonly started: ExecutorSample;
    readonly finished: ExecutorSample;
}

interface ObservedProbe extends ExecutorSpan {
    readonly advertisedLanes: DequeueController.WorkAdvertisement;
}

interface ObservedHandler {
    readonly attempt: ResourceInboxAttempt;
    readonly started: ExecutorSample;
    finished: ExecutorSample | undefined;
}

interface ObservedPass {
    readonly probe: ObservedProbe | undefined;
    readonly started: ExecutorSample;
    readonly handlers: ObservedHandler[];
}

/** What the queue machinery itself cost: the probe plus the pass, less the time any handler ran. */
interface DequeuePassCost {
    readonly durationMs: number;
    readonly counters: RallarTimingDetails;
}

export namespace AppInboxDequeuePassTiming {
    export interface Dependencies {
        readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
        readonly nowMs: () => number;
    }

    export interface Config {
        readonly serviceId: string;
        readonly sink: RallarTimingSink;
    }
}

/**
 * One `app-inbox-phase` `dequeue-pass` line per claimed entry, on the inbox and on the outbox pass,
 * carrying the executor cost of the pass outside the handlers: the probe, the reservations and the
 * releases, with the lanes the probe advertised and the claimed type. The executor is shared, so
 * statements other callers ran meanwhile are counted too.
 */
export class AppInboxDequeuePassTiming implements QueueMessageReader.DequeuePassObserver {
    private readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
    private readonly nowMs: () => number;
    private readonly config: AppInboxDequeuePassTiming.Config;

    private probeStarted: ExecutorSample | undefined;
    private probe: ObservedProbe | undefined;
    private pass: ObservedPass | undefined;

    constructor(dependencies: AppInboxDequeuePassTiming.Dependencies, config: AppInboxDequeuePassTiming.Config) {
        this.database = dependencies.database;
        this.nowMs = dependencies.nowMs;
        this.config = config;
    }

    onProbeStarted(): void {
        this.probe = undefined;
        this.probeStarted = this.sample();
    }

    onProbeFinished(advertisedLanes: DequeueController.WorkAdvertisement): void {
        if (this.probeStarted === undefined) {
            return;
        }
        this.probe = { started: this.probeStarted, finished: this.sample(), advertisedLanes };
        this.probeStarted = undefined;
    }

    onPassStarted(): void {
        this.pass = { probe: this.probe, started: this.sample(), handlers: [] };
        this.probe = undefined;
    }

    onHandlerStarted(attempt: ResourceInboxAttempt): void {
        this.pass?.handlers.push({ attempt, started: this.sample(), finished: undefined });
    }

    onHandlerFinished(attempt: ResourceInboxAttempt): void {
        const handler = this.pass?.handlers.findLast((candidate) =>
            candidate.attempt === attempt && candidate.finished === undefined
        );
        if (handler !== undefined) {
            handler.finished = this.sample();
        }
    }

    onPassFinished(): void {
        const pass = this.pass;
        this.pass = undefined;
        if (pass === undefined || pass.handlers.length === 0) {
            return;
        }
        const finished = this.sample();
        const cost = computeDequeuePassCost(pass, finished);
        const lanesProbed = pass.probe === undefined ? '' : toLanesProbed(pass.probe.advertisedLanes);
        for (const handler of pass.handlers) {
            recordRallarTiming({
                sink: this.config.sink,
                event: {
                    component: 'app-inbox-phase',
                    operation: 'dequeue-pass',
                    serviceId: this.config.serviceId,
                    requestId: handler.attempt.entry.key.resourceId,
                    details: {
                        ...toClaimedAttemptDetails(handler.attempt),
                        ...cost.counters,
                        lanesProbed,
                        claimedInPass: pass.handlers.length
                    }
                },
                status: 'ok',
                durationMs: cost.durationMs
            });
        }
    }

    private sample(): ExecutorSample {
        return { atMs: this.nowMs(), counters: this.database.getExecutorCounters?.() };
    }
}

/** Concurrent handlers overlap, so their time is their spans' union, which the pass span always contains. */
function computeDequeuePassCost(pass: ObservedPass, finished: ExecutorSample): DequeuePassCost {
    const passSpan = { started: pass.started, finished };
    const spans: ExecutorSpan[] = pass.probe === undefined ? [passSpan] : [passSpan, pass.probe];
    const handlerSpans = toSpanUnion(
        pass.handlers.flatMap((handler) =>
            handler.finished === undefined ? [] : [{ started: handler.started, finished: handler.finished }]
        )
    );
    const handlersMs = sumDurationMs(handlerSpans);
    const timing = { passWallMs: toRoundedMs(sumDurationMs([passSpan])), handlersMs: toRoundedMs(handlersMs) };
    const durationMs = sumDurationMs(spans) - handlersMs;
    const counted = [...spans, ...handlerSpans].every((span) =>
        span.started.counters !== undefined && span.finished.counters !== undefined
    );
    if (!counted) {
        return { durationMs, counters: timing };
    }
    const statements = sumStatements(spans) - sumStatements(handlerSpans);
    const executorWaitMs = sumExecutorWaitMs(spans) - sumExecutorWaitMs(handlerSpans);
    return {
        durationMs,
        counters: {
            ...toExecutorCounterDeltaDetails({ statements: 0, executorWaitMs: 0 }, { statements, executorWaitMs }),
            ...timing
        }
    };
}

/** Overlapping spans merge into one, from the earliest start sample to the latest finish sample. */
function toSpanUnion(spans: readonly ExecutorSpan[]): readonly ExecutorSpan[] {
    const merged: ExecutorSpan[] = [];
    for (const span of [...spans].sort((left, right) => left.started.atMs - right.started.atMs)) {
        const last = merged.at(-1);
        if (last === undefined || span.started.atMs > last.finished.atMs) {
            merged.push(span);
        }
        else if (span.finished.atMs > last.finished.atMs) {
            merged[merged.length - 1] = { started: last.started, finished: span.finished };
        }
    }
    return merged;
}

function toRoundedMs(durationMs: number): number {
    return Math.round(durationMs * 100) / 100;
}

function sumDurationMs(spans: readonly ExecutorSpan[]): number {
    return spans.reduce((total, span) => total + (span.finished.atMs - span.started.atMs), 0);
}

function sumStatements(spans: readonly ExecutorSpan[]): number {
    return spans.reduce(
        (total, span) => total + (span.finished.counters!.statements - span.started.counters!.statements),
        0
    );
}

function sumExecutorWaitMs(spans: readonly ExecutorSpan[]): number {
    return spans.reduce(
        (total, span) => total + (span.finished.counters!.executorWaitMs - span.started.counters!.executorWaitMs),
        0
    );
}

function toLanesProbed(advertisedLanes: DequeueController.WorkAdvertisement): string {
    return Object.values(Reservator).filter((lane) => advertisedLanes[lane]).join(',');
}

function toClaimedAttemptDetails(attempt: ResourceInboxAttempt): RallarTimingDetails {
    if (attempt.entry.typeId !== EnqueuedType.APP_INBOX) {
        return toClaimedEntryDetails(attempt, toQueuedMessageTypeId(attempt.entry));
    }
    const identity = validateAppInboxCommandIdentity(attempt.entry);
    if (identity.valid) {
        return toAppInboxAttemptTimingDetails(identity.command, attempt.entry, attempt.telemetry);
    }
    return toClaimedEntryDetails(attempt, identity.identity.operation);
}

/** The queued message's type as the dispatcher reads it; a malformed entry names its queue type. */
function toQueuedMessageTypeId(entry: ResourceEntry): string {
    try {
        return QueueMessageReader.decodeQueuedMessage(entry).payload.typeId;
    }
    catch {
        return `${entry.typeId}:malformed`;
    }
}

function toClaimedEntryDetails(attempt: ResourceInboxAttempt, type: string): RallarTimingDetails {
    return {
        type,
        topicId: attempt.entry.key.topicId,
        contextId: attempt.entry.key.contextId,
        resourceId: attempt.entry.key.resourceId,
        senderId: undefined,
        attempt: attempt.telemetry.attempt,
        selectedLane: attempt.telemetry.selectedLane,
        queueAgeMs: attempt.telemetry.queueAgeMs,
        dueAgeMs: attempt.telemetry.dueAgeMs
    };
}
