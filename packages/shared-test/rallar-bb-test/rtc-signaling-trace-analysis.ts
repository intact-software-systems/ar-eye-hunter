import {
    RTC_SIGNALING_TRACE_LOG_PREFIX,
    type RtcSignalingTraceEvent,
    type RtcSignalingTraceStage,
} from '@shared/webrtc/RtcSignalingTrace.ts';

export type RtcSignalingBoundaryName =
    | 'enqueueToSend'
    | 'outboxToServer'
    | 'serverProcessing'
    | 'serverToInbox'
    | 'inboxToRtc'
    | 'endToEnd';

export type RtcSignalingLatencySummary = Readonly<{
    count: number;
    p50Ms?: number;
    p95Ms?: number;
    maxMs?: number;
}>;

export type RtcSignalingBoundarySummaries = Readonly<
    Record<RtcSignalingBoundaryName, RtcSignalingLatencySummary>
>;

export type RtcSignalingTypeAnalysis = Readonly<{
    messages: number;
    completeMessages: number;
    boundaries: RtcSignalingBoundarySummaries;
}>;

export type RtcSignalingTraceAnalysis = Readonly<{
    events: number;
    messages: number;
    completeMessages: number;
    boundaries: RtcSignalingBoundarySummaries;
    bySignalType: Readonly<Record<RtcSignalType, RtcSignalingTypeAnalysis>>;
    missingStages: Readonly<Record<RtcSignalingTraceStage, number>>;
    warnings: readonly string[];
    markdown: string;
}>;

type RtcSignalType = 'Offer' | 'Answer' | 'IceCandidate';

const STAGES: readonly RtcSignalingTraceStage[] = [
    'client-outbox-enqueued',
    'client-outbox-sent',
    'server-inbox-received',
    'server-forwarded',
    'client-inbox-received',
    'rtc-dispatched',
];

const SIGNAL_TYPES: readonly RtcSignalType[] = [
    'Offer',
    'Answer',
    'IceCandidate',
];

const BOUNDARIES: readonly RtcSignalingBoundaryName[] = [
    'enqueueToSend',
    'outboxToServer',
    'serverProcessing',
    'serverToInbox',
    'inboxToRtc',
    'endToEnd',
];

type CorrelatedMessage = Readonly<{
    signalType: RtcSignalType;
    stages: ReadonlyMap<RtcSignalingTraceStage, RtcSignalingTraceEvent>;
    serverReceivedAtEpochMs?: number;
    serverForwardedAtEpochMs?: number;
}>;

export function analyzeRtcSignalingTraceLogs(
    text: string,
): RtcSignalingTraceAnalysis {
    const warnings: string[] = [];
    const uniqueEvents = extractEvents(text, warnings);
    const messages = correlateEvents(uniqueEvents, warnings);
    const allDurations = newDurationMap();
    const durationsBySignalType = Object.fromEntries(
        SIGNAL_TYPES.map((signalType) => [signalType, newDurationMap()]),
    ) as Record<RtcSignalType, Map<RtcSignalingBoundaryName, number[]>>;
    const messageCounts = Object.fromEntries(
        SIGNAL_TYPES.map((signalType) => [signalType, 0]),
    ) as Record<RtcSignalType, number>;
    const completeCounts = Object.fromEntries(
        SIGNAL_TYPES.map((signalType) => [signalType, 0]),
    ) as Record<RtcSignalType, number>;
    const missingStages = Object.fromEntries(
        STAGES.map((stage) => [stage, 0]),
    ) as Record<RtcSignalingTraceStage, number>;

    let completeMessages = 0;
    for (const [messageId, message] of messages) {
        messageCounts[message.signalType] += 1;
        for (const stage of STAGES) {
            if (!message.stages.has(stage)) {
                missingStages[stage] += 1;
            }
        }

        const isComplete = message.stages.has('client-inbox-received') &&
            message.stages.has('rtc-dispatched');
        if (isComplete) {
            completeMessages += 1;
            completeCounts[message.signalType] += 1;
        }

        for (const [boundary, duration] of calculateDurations(message)) {
            if (duration < 0) {
                warnings.push(
                    `Message ${messageId} has negative ${boundary} latency (${duration} ms); omitted.`,
                );
                continue;
            }
            allDurations.get(boundary)!.push(duration);
            durationsBySignalType[message.signalType].get(boundary)!.push(duration);
        }
    }

    const boundaries = summarizeDurations(allDurations);
    const bySignalType = Object.fromEntries(
        SIGNAL_TYPES.map((signalType) => [
            signalType,
            {
                messages: messageCounts[signalType],
                completeMessages: completeCounts[signalType],
                boundaries: summarizeDurations(durationsBySignalType[signalType]),
            },
        ]),
    ) as Record<RtcSignalType, RtcSignalingTypeAnalysis>;
    const base = {
        events: uniqueEvents.length,
        messages: messages.size,
        completeMessages,
        boundaries,
        bySignalType,
        missingStages,
        warnings,
    };

    return {
        ...base,
        markdown: renderRtcSignalingTraceMarkdown(base),
    };
}

function extractEvents(
    text: string,
    warnings: string[],
): RtcSignalingTraceEvent[] {
    const deduped = new Map<string, RtcSignalingTraceEvent>();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const prefixIndex = lines[index].indexOf(RTC_SIGNALING_TRACE_LOG_PREFIX);
        if (prefixIndex < 0) {
            continue;
        }
        const raw = lines[index].slice(
            prefixIndex + RTC_SIGNALING_TRACE_LOG_PREFIX.length,
        ).trim();
        let candidate: unknown;
        try {
            candidate = JSON.parse(raw);
        } catch {
            warnings.push(`Line ${index + 1}: invalid trace JSON.`);
            continue;
        }
        if (!isRtcSignalingTraceEvent(candidate)) {
            warnings.push(`Line ${index + 1}: invalid trace event fields.`);
            continue;
        }
        const key = `${candidate.messageId}\u0000${candidate.stage}\u0000${candidate.atEpochMs}`;
        if (!deduped.has(key)) {
            deduped.set(key, candidate);
        }
    }
    return [...deduped.values()];
}

function correlateEvents(
    events: readonly RtcSignalingTraceEvent[],
    warnings: string[],
): Map<string, CorrelatedMessage> {
    const grouped = new Map<string, RtcSignalingTraceEvent[]>();
    for (const event of events) {
        const existing = grouped.get(event.messageId) ?? [];
        existing.push(event);
        grouped.set(event.messageId, existing);
    }

    const correlated = new Map<string, CorrelatedMessage>();
    for (const [messageId, messageEvents] of grouped) {
        const ordered = [...messageEvents].sort((left, right) =>
            left.atEpochMs - right.atEpochMs
        );
        const signalType = ordered[0].signalType as RtcSignalType;
        if (ordered.some((event) => event.signalType !== signalType)) {
            warnings.push(`Message ${messageId} has inconsistent signal types.`);
        }
        const stages = new Map<RtcSignalingTraceStage, RtcSignalingTraceEvent>();
        for (const event of ordered) {
            if (!stages.has(event.stage)) {
                stages.set(event.stage, event);
            }
        }

        const serverReceivedAtEpochMs = readServerReceivedAt(ordered);
        const serverForwardedAtEpochMs = readServerForwardedAt(stages);
        correlated.set(messageId, {
            signalType,
            stages,
            serverReceivedAtEpochMs,
            serverForwardedAtEpochMs,
        });
    }
    return correlated;
}

function readServerReceivedAt(
    events: readonly RtcSignalingTraceEvent[],
): number | undefined {
    const explicit = events.find((event) => event.stage === 'server-inbox-received');
    if (explicit) {
        return explicit.serverReceivedAtEpochMs ?? explicit.atEpochMs;
    }
    return minDefined(events.map((event) => event.serverReceivedAtEpochMs));
}

function readServerForwardedAt(
    stages: ReadonlyMap<RtcSignalingTraceStage, RtcSignalingTraceEvent>,
): number | undefined {
    const explicit = stages.get('server-forwarded');
    if (explicit) {
        return explicit.serverForwardedAtEpochMs ?? explicit.atEpochMs;
    }
    return stages.get('client-inbox-received')?.serverForwardedAtEpochMs ??
        stages.get('rtc-dispatched')?.serverForwardedAtEpochMs;
}

function calculateDurations(
    message: CorrelatedMessage,
): Map<RtcSignalingBoundaryName, number> {
    const result = new Map<RtcSignalingBoundaryName, number>();
    const enqueue = message.stages.get('client-outbox-enqueued')?.atEpochMs;
    const send = message.stages.get('client-outbox-sent')?.atEpochMs;
    const inbox = message.stages.get('client-inbox-received')?.atEpochMs;
    const dispatch = message.stages.get('rtc-dispatched')?.atEpochMs;
    addDuration(result, 'enqueueToSend', enqueue, send);
    addDuration(result, 'outboxToServer', send, message.serverReceivedAtEpochMs);
    addDuration(
        result,
        'serverProcessing',
        message.serverReceivedAtEpochMs,
        message.serverForwardedAtEpochMs,
    );
    addDuration(
        result,
        'serverToInbox',
        message.serverForwardedAtEpochMs,
        inbox,
    );
    addDuration(result, 'inboxToRtc', inbox, dispatch);
    addDuration(result, 'endToEnd', enqueue, dispatch);
    return result;
}

function addDuration(
    target: Map<RtcSignalingBoundaryName, number>,
    boundary: RtcSignalingBoundaryName,
    from: number | undefined,
    to: number | undefined,
): void {
    if (from !== undefined && to !== undefined) {
        target.set(boundary, to - from);
    }
}

function newDurationMap(): Map<RtcSignalingBoundaryName, number[]> {
    return new Map(BOUNDARIES.map((boundary) => [boundary, []]));
}

function summarizeDurations(
    durations: ReadonlyMap<RtcSignalingBoundaryName, readonly number[]>,
): RtcSignalingBoundarySummaries {
    return Object.fromEntries(
        BOUNDARIES.map((boundary) => [
            boundary,
            summarize(durations.get(boundary) ?? []),
        ]),
    ) as Record<RtcSignalingBoundaryName, RtcSignalingLatencySummary>;
}

function summarize(values: readonly number[]): RtcSignalingLatencySummary {
    if (values.length === 0) {
        return { count: 0 };
    }
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted[sorted.length - 1],
    };
}

function percentile(sorted: readonly number[], quantile: number): number {
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function renderRtcSignalingTraceMarkdown(
    analysis: Omit<RtcSignalingTraceAnalysis, 'markdown'>,
): string {
    const labels: Record<RtcSignalingBoundaryName, string> = {
        enqueueToSend: 'outbox-enqueue → outbox-send',
        outboxToServer: 'outbox-send → server-receive',
        serverProcessing: 'server-receive → server-forward',
        serverToInbox: 'server-forward → target-inbox',
        inboxToRtc: 'target-inbox → RTC-dispatch',
        endToEnd: 'outbox-enqueue → RTC-dispatch',
    };
    const rows = BOUNDARIES.map((boundary) => {
        const summary = analysis.boundaries[boundary];
        return `| ${labels[boundary]} | ${summary.count} | ${formatMs(summary.p50Ms)} | ${formatMs(summary.p95Ms)} | ${formatMs(summary.maxMs)} |`;
    });
    const typeRows = SIGNAL_TYPES.map((signalType) => {
        const summary = analysis.bySignalType[signalType];
        return `| ${signalType} | ${summary.messages} | ${summary.completeMessages} |`;
    });
    return [
        '# RTC signaling boundary analysis',
        '',
        `Correlated ${analysis.events} events across ${analysis.messages} messages; ${analysis.completeMessages} reached RTC dispatch after target inbox.`,
        '',
        '| Signal type | Messages | Completed |',
        '| --- | ---: | ---: |',
        ...typeRows,
        '',
        '| Boundary | Samples | p50 | p95 | max |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...rows,
        '',
        `Parse/clock warnings: ${analysis.warnings.length}.`,
        '',
    ].join('\n');
}

function formatMs(value: number | undefined): string {
    return value === undefined ? '—' : `${value} ms`;
}

function minDefined(values: readonly (number | undefined)[]): number | undefined {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length === 0 ? undefined : Math.min(...defined);
}

function isRtcSignalingTraceEvent(value: unknown): value is RtcSignalingTraceEvent {
    if (!isRecord(value)) {
        return false;
    }
    return value.schemaVersion === 1 &&
        isStage(value.stage) &&
        isNonEmptyString(value.messageId) &&
        isFiniteNumber(value.messageCreatedAtEpochMs) &&
        isFiniteNumber(value.atEpochMs) &&
        isFiniteNumber(value.elapsedMs) &&
        isSignalType(value.signalType) &&
        isNonEmptyString(value.fromId) &&
        isNonEmptyString(value.toId) &&
        isOptionalFiniteNumber(value.serverReceivedAtEpochMs) &&
        isOptionalFiniteNumber(value.serverForwardedAtEpochMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStage(value: unknown): value is RtcSignalingTraceStage {
    return typeof value === 'string' && STAGES.includes(value as RtcSignalingTraceStage);
}

function isSignalType(value: unknown): value is RtcSignalType {
    return typeof value === 'string' && SIGNAL_TYPES.includes(value as RtcSignalType);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || isFiniteNumber(value);
}
