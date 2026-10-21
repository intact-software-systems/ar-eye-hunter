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

/** A probe or a pass, with the time handlers ran inside it: a handler that started before it or outlives it is clipped. */
interface ObservedWindow {
    readonly started: ExecutorSample;
    readonly handlerSpans: ExecutorSpan[];
}

interface ObservedProbe extends ExecutorSpan {
    readonly advertisedLanes: DequeueController.WorkAdvertisement;
    readonly handlerSpans: readonly ExecutorSpan[];
}

interface ObservedPass extends ObservedWindow {
    readonly probe: ObservedProbe | undefined;
    readonly claimed: ResourceInboxAttempt[];
}

/** A finished pass: its closing sample and the handler time inside it. */
interface ClosedPass {
    readonly finished: ExecutorSample;
    readonly handlerSpans: readonly ExecutorSpan[];
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
        /** The queue type of the reader whose passes this observes, which names the pass a boundary line closes. */
        readonly queueType: string;
        readonly sink: RallarTimingSink;
    }
}

/**
 * One `app-inbox-phase` `dequeue-pass` line per claimed entry, on the inbox and on the outbox pass,
 * carrying the executor cost of the pass outside the handlers: the probe, the reservations and the
 * releases, with the lanes the probe advertised, the claimed type, and the entry's row id and creation
 * time, so a row claimed ahead of an older one shows. The executor is shared, so
 * statements other callers ran meanwhile are counted too. An entry belongs to the pass that claimed it,
 * even when its handler runs after that pass; a pass subtracts only the handler time inside it.
 *
 * Every pass, one that claimed nothing included, closes with one `dequeue-pass-boundary` line: the queue
 * type of the reader, its wall time as the duration, so it started at `atEpochMs - durationMs`, the
 * entries it claimed per lane, and how long its probe took and then waited for the pass to start.
 */
export class AppInboxDequeuePassTiming implements QueueMessageReader.DequeuePassObserver {
    private readonly database: Pick<PSqlSql, 'getExecutorCounters'>;
    private readonly nowMs: () => number;
    private readonly config: AppInboxDequeuePassTiming.Config;

    private probeWindow: ObservedWindow | undefined;
    private probe: ObservedProbe | undefined;
    private pass: ObservedPass | undefined;
    private readonly runningHandlers = new Map<ResourceInboxAttempt, ExecutorSample>();

    constructor(dependencies: AppInboxDequeuePassTiming.Dependencies, config: AppInboxDequeuePassTiming.Config) {
        this.database = dependencies.database;
        this.nowMs = dependencies.nowMs;
        this.config = config;
    }

    onProbeStarted(): void {
        this.probe = undefined;
        this.probeWindow = { started: this.sample(), handlerSpans: [] };
    }

    onProbeFinished(advertisedLanes: DequeueController.WorkAdvertisement): void {
        const window = this.probeWindow;
        if (window === undefined) {
            return;
        }
        const finished = this.sample();
        this.probe = {
            started: window.started,
            finished,
            advertisedLanes,
            handlerSpans: this.closeWindow(window, finished)
        };
        this.probeWindow = undefined;
    }

    onPassStarted(): void {
        this.pass = { probe: this.probe, started: this.sample(), claimed: [], handlerSpans: [] };
        this.probe = undefined;
    }

    onEntryClaimed(attempt: ResourceInboxAttempt): void {
        this.pass?.claimed.push(attempt);
    }

    onHandlerStarted(attempt: ResourceInboxAttempt): void {
        this.runningHandlers.set(attempt, this.sample());
    }

    onHandlerFinished(attempt: ResourceInboxAttempt): void {
        const started = this.runningHandlers.get(attempt);
        if (started === undefined) {
            return;
        }
        this.runningHandlers.delete(attempt);
        const finished = this.sample();
        for (const window of [this.probeWindow, this.pass]) {
            window?.handlerSpans.push({ started: toLaterSample(started, window.started), finished });
        }
    }

    onPassFinished(): void {
        const pass = this.pass;
        this.pass = undefined;
        if (pass === undefined) {
            return;
        }
        const finished = this.sample();
        const handlerSpans = this.closeWindow(pass, finished);
        this.recordClaimedEntries(pass, { finished, handlerSpans });
        recordRallarTiming({
            sink: this.config.sink,
            event: {
                component: 'app-inbox-phase',
                operation: 'dequeue-pass-boundary',
                serviceId: this.config.serviceId,
                details: { queueType: this.config.queueType, ...toPassBoundaryDetails(pass, finished) }
            },
            status: 'ok',
            durationMs: finished.atMs - pass.started.atMs
        });
    }

    private recordClaimedEntries(pass: ObservedPass, closed: ClosedPass): void {
        if (pass.claimed.length === 0) {
            return;
        }
        const cost = computeDequeuePassCost(pass, closed);
        const lanesProbed = pass.probe === undefined ? '' : toLanesProbed(pass.probe.advertisedLanes);
        for (const attempt of pass.claimed) {
            recordRallarTiming({
                sink: this.config.sink,
                event: {
                    component: 'app-inbox-phase',
                    operation: 'dequeue-pass',
                    serviceId: this.config.serviceId,
                    requestId: attempt.entry.key.resourceId,
                    details: {
                        ...toClaimedAttemptDetails(attempt),
                        ...cost.counters,
                        lanesProbed,
                        claimedInPass: pass.claimed.length,
                        rowId: attempt.entry.db?.id,
                        createdTs: attempt.entry.audit.createdTs.toString()
                    }
                },
                status: 'ok',
                durationMs: cost.durationMs
            });
        }
    }

    /** The handler spans inside the window, with every handler still running clipped to its close. */
    private closeWindow(window: ObservedWindow, finished: ExecutorSample): readonly ExecutorSpan[] {
        const running = [...this.runningHandlers.values()].map((started) => ({
            started: toLaterSample(started, window.started),
            finished
        }));
        return [...window.handlerSpans, ...running];
    }

    private sample(): ExecutorSample {
        return { atMs: this.nowMs(), counters: this.database.getExecutorCounters?.() };
    }
}

function toLaterSample(left: ExecutorSample, right: ExecutorSample): ExecutorSample {
    return left.atMs < right.atMs ? right : left;
}

/**
 * Concurrent handlers overlap, so their time is their spans' union, which the window it was clipped to always
 * contains. The probe and the pass are separate windows, so each subtracts the union of its own handler spans.
 */
function computeDequeuePassCost(pass: ObservedPass, closed: ClosedPass): DequeuePassCost {
    const passSpan = { started: pass.started, finished: closed.finished };
    const spans: ExecutorSpan[] = pass.probe === undefined ? [passSpan] : [passSpan, pass.probe];
    const handlerSpans = [
        ...toSpanUnion(closed.handlerSpans),
        ...toSpanUnion(pass.probe?.handlerSpans ?? [])
    ];
    const handlersMs = sumDurationMs(handlerSpans);
    const timing = {
        passWallMs: toRoundedMs(sumDurationMs([passSpan])),
        handlersMs: toRoundedMs(sumDurationMs(toSpanUnion(closed.handlerSpans)))
    };
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

function toPassBoundaryDetails(pass: ObservedPass, finished: ExecutorSample): RallarTimingDetails {
    const { probe } = pass;
    return {
        passWallMs: toRoundedMs(finished.atMs - pass.started.atMs),
        lanesProbed: probe === undefined ? '' : toLanesProbed(probe.advertisedLanes),
        probeMs: probe === undefined ? undefined : toRoundedMs(probe.finished.atMs - probe.started.atMs),
        probeToPassMs: probe === undefined ? undefined : toRoundedMs(pass.started.atMs - probe.finished.atMs),
        claimedInPass: pass.claimed.length,
        ...toClaimedPerLaneDetails(pass.claimed)
    };
}

function toClaimedPerLaneDetails(claimed: readonly ResourceInboxAttempt[]): RallarTimingDetails {
    const counts: Record<Reservator, number> = { FINALIZATION: 0, NEW: 0, RETRY: 0, FAIRNESS: 0, TIMEOUT: 0 };
    for (const attempt of claimed) {
        counts[attempt.telemetry.selectedLane] += 1;
    }
    return {
        claimedNew: counts.NEW,
        claimedRetry: counts.RETRY,
        claimedFairness: counts.FAIRNESS,
        claimedTimeout: counts.TIMEOUT,
        claimedFinalization: counts.FINALIZATION
    };
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
