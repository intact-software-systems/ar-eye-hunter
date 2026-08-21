import type { RallarBlackBoxTestEvent } from '@shared-test/rallar-bb-test/types.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import { formatDuration, formatRelativeDuration, formatTime } from '../../shared/time-format.ts';

export function isRallarBrowserEvent(
    event: RallarBlackBoxTestEvent
): boolean {
    return (
        event.topic === 'rallar.browser.event' ||
        event.topic.startsWith('rallar.browser.') ||
        event.topic.startsWith('rallar.direct.')
    );
}

export function isRallarTraceEvent(event: RallarBlackBoxTestEvent): boolean {
    return (
        isRallarBrowserEvent(event) || event.topic.startsWith('rallar.server.')
    );
}

export function rallarTraceSource(
    event: RallarBlackBoxTestEvent
): 'browser' | 'direct' | 'server' {
    if (event.topic.startsWith('rallar.server.')) {
        return 'server';
    }
    if (event.topic.startsWith('rallar.direct.')) {
        return 'direct';
    }
    return 'browser';
}

export function eventPayloadDetails(
    event: RallarBlackBoxTestEvent
): Record<string, unknown> {
    const payload = optionalRecord(event.payload);
    return {
        ...payload,
        ...optionalRecord(payload.data)
    };
}

export function eventPayloadText(event: RallarBlackBoxTestEvent): string {
    const payload = eventPayloadDetails(event);
    return (
        [
            stringValue(payload.phase),
            stringValue(payload.status),
            stringValue(optionalRecord(payload.status).readyState),
            stringValue(payload.action),
            stringValue(payload.kind),
            stringValue(payload.connection),
            stringValue(payload.remotePeerId),
            stringValue(payload.error),
            stringValue(optionalRecord(payload.error).message)
        ]
            .filter((value): value is string => Boolean(value && value.length > 0))
            .join(' - ') || '-'
    );
}

export function eventFailureText(event: RallarBlackBoxTestEvent): string {
    const payload = eventPayloadDetails(event);
    const error = optionalRecord(payload.error);
    const response = optionalRecord(payload.response);
    return (
        [
            stringValue(payload.message),
            stringValue(payload.reason),
            stringValue(payload.statusText),
            stringValue(error.message),
            stringValue(payload.error),
            stringValue(response.bodyText),
            stringValue(payload.bodyText)
        ]
            .filter((value): value is string => Boolean(value && value.length > 0))
            .join('\n') || eventPayloadText(event)
    );
}

export function traceTimingText(
    event: RallarBlackBoxTestEvent,
    previousEvent: RallarBlackBoxTestEvent | undefined,
    now: number
): string {
    const ageMs = Math.max(0, now - event.atEpochMs);
    const deltaMs = previousEvent
        ? Math.max(0, event.atEpochMs - previousEvent.atEpochMs)
        : undefined;
    return [
        formatTime(event.atEpochMs),
        `${formatRelativeDuration(ageMs)} ago`,
        deltaMs === undefined ? 'first' : `+${formatDuration(deltaMs)}`
    ].join(' - ');
}

export function traceMetaText(event: RallarBlackBoxTestEvent): string {
    return [
        rallarTraceSource(event),
        event.kind,
        event.severity,
        event.transport ?? 'runtime',
        event.connection,
        event.actor
    ]
        .filter((value): value is string => Boolean(value && value.length > 0))
        .join(' - ');
}
