import { expect, it } from 'vitest';

import { controlEventArtifactJsonl } from '../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { readRtcB06Journal } from '../../shared-rtc-bench/baseline/acceptance/rtc-b06-journal.ts';
import {
    toRtcB06BrowserRecordingReadings,
    type RtcB06BrowserRecordingReading
} from '../../shared-rtc-bench/baseline/acceptance/validate-rtc-b06-browser-recording.ts';
import type { RallarBlackBoxEventHistory } from '../../shared-test/rallar-bb-test/runtime/event-history.ts';

interface JournalFixture {
    readonly boundaries: readonly RtcB06BrowserRecordingReading[];
    readonly rows: ReturnType<typeof createJournalRows>;
    readonly bytes: Uint8Array;
}

const kinds = { event: 0, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 };
const encoder = new TextEncoder();

function createEventHistory(agentId: string, totalEvents: number): RallarBlackBoxEventHistory {
    return {
        runtimeId: `runtime-${agentId}`,
        generation: 1,
        totalEvents,
        policy: { mode: 'recent', maxEvents: 64 },
        retainedEvents: totalEvents,
        evictedEvents: 0,
        evictedThroughEpochMs: undefined,
        countsByKind: { ...kinds, event: totalEvents - 2, result: 2 },
        reconnects: 0,
        capture: { status: 'continuous', identity: { runId: 'run', agentId }, start: { runtimeId: `runtime-${agentId}`, generation: 1, ordinal: 4 } }
    };
}

function createJournalFixture(): JournalFixture {
    const checkpoint = {
        cycle: 100,
        agents: ['a', 'b', 'c'].map((agentId) => ({
            agentId,
            details: {
                browserDiagnostics: { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: 10, forwardedBrowserDiagnostics: 10 },
                browserDiagnosticsAdmission: {
                    runId: 'run',
                    agentId,
                    commandId: `admit-${agentId}`,
                    receipt: { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: 1, forwardedBrowserDiagnostics: 1 },
                    eventHistory: createEventHistory(agentId, 4)
                },
                browserDiagnosticsHealth: { runId: 'run', agentId, commandId: `rtc-diagnostics-${agentId}-retention-100-suffix` },
                eventHistory: createEventHistory(agentId, 6)
            }
        }))
    };
    const boundaries = toRtcB06BrowserRecordingReadings(JSON.parse(JSON.stringify(checkpoint)))!;
    const rows = createJournalRows();
    return { boundaries, rows, bytes: encoder.encode(rows.map((row) => JSON.stringify(row)).join('\n') + '\n') };
}

function createJournalRows() {
    return ['a', 'b', 'c'].flatMap((agentId) => [
        {
            kind: 'step-result',
            status: 'SUCCESS',
            action: 'health',
            name: `admit-${agentId}`,
            commandId: `admit-${agentId}`,
            agentId,
            actual: { stats: { eventHistory: createEventHistory(agentId, 4) } }
        },
        ...[4, 5, 6, 7, 8].map((ordinal) => ({
            kind: 'rtc-diagnostic',
            status: 'event',
            agentId,
            value: {
                eventId: `${agentId}-${ordinal}`,
                kind: 'event',
                topic: 'rallar.browser.é',
                atEpochMs: ordinal,
                severity: 'info',
                payload: {},
                history: { runtimeId: `runtime-${agentId}`, generation: 1, ordinal }
            }
        })),
        {
            kind: 'step-result',
            status: 'SUCCESS',
            action: 'health',
            name: `rtc-diagnostics-${agentId}-retention-100-suffix`,
            commandId: `rtc-diagnostics-${agentId}-retention-100-suffix`,
            agentId,
            actual: { stats: { eventHistory: createEventHistory(agentId, 6) } }
        }
    ]);
}

async function* toJournalChunks(bytes: Uint8Array, size: number) {
    for (let offset = 0; offset < bytes.length; offset += size) {
        yield bytes.subarray(offset, offset + size);
    }
}

it('proves the captured non-one start and independent Health kind delta through three disk result markers', async () => {
    const fixture = createJournalFixture();
    const result = await readRtcB06Journal(toJournalChunks(fixture.bytes, 1), fixture.boundaries);
    expect(result.left).toBeUndefined();
    expect(result.right).toMatchObject({
        bytes: fixture.bytes.length,
        rows: 21,
        agents: [
            { agentId: 'a', capturedRows: 3, countsAfterFirstHealth: { ...kinds, event: 2 } },
            { agentId: 'b', capturedRows: 3, countsAfterFirstHealth: { ...kinds, event: 2 } },
            { agentId: 'c', capturedRows: 3, countsAfterFirstHealth: { ...kinds, event: 2 } }
        ]
    });
});

it.each(
    [
        'gap',
        'duplicate',
        'order',
        'generation',
        'runtime',
        'agent',
        'control',
        'kind',
        'outer-kind',
        'malformed-history',
        'missing-history',
        'counter',
        'missing-marker',
        'wrong-marker-health',
        'missing-admission-marker',
        'duplicate-marker',
        'empty-event-id',
        'empty-topic'
    ] as const
)('rejects %s instead of certifying incomplete capture', async (failure) => {
    const fixture = createJournalFixture();
    const row = fixture.rows[2];
    if (!('value' in row)) {
        throw new Error('Runtime fixture missing.');
    }
    if (failure === 'empty-event-id') {
        row.value.eventId = '';
    }
    if (failure === 'empty-topic') {
        row.value.topic = '';
    }
    if (failure === 'gap') {
        fixture.rows.splice(2, 1);
    }
    if (failure === 'duplicate') {
        fixture.rows.splice(2, 0, row);
    }
    if (failure === 'order') {
        [fixture.rows[1], fixture.rows[2]] = [fixture.rows[2], fixture.rows[1]];
    }
    if (failure === 'generation') {
        row.value.history.generation = 2;
    }
    if (failure === 'runtime') {
        row.value.history.runtimeId = 'other';
    }
    if (failure === 'agent') {
        row.agentId = 'other';
    }
    if (failure === 'control') {
        Object.assign(row.value, { control: { runId: 'other', agentId: 'a', rootCommandId: 'command' } });
    }
    if (failure === 'kind') {
        row.value.kind = 'invalid';
    }
    if (failure === 'outer-kind') {
        Object.assign(row, { kind: ['rtc-diagnostic'] });
    }
    if (failure === 'malformed-history') {
        Object.assign(row.value, { history: { ordinal: '5' } });
    }
    if (failure === 'missing-history') {
        Reflect.deleteProperty(row.value, 'history');
    }
    if (failure === 'counter') {
        row.value.kind = 'stats';
        row.status = 'stats';
    }
    if (failure === 'missing-admission-marker') {
        fixture.rows.shift();
    }
    if (failure === 'duplicate-marker') {
        fixture.rows.splice(0, 0, fixture.rows[0]);
    }
    if (failure === 'missing-marker') {
        fixture.rows.pop();
    }
    if (failure === 'wrong-marker-health') {
        Object.assign(fixture.rows.at(-1)!, { actual: { stats: { eventHistory: createEventHistory('c', 5) } } });
    }
    const bytes = encoder.encode(fixture.rows.map((value) => JSON.stringify(value)).join('\n') + '\n');
    expect((await readRtcB06Journal(toJournalChunks(bytes, 13), fixture.boundaries)).left).toBeDefined();
});

it.each(['invalid-utf8', 'truncated-line', 'oversized-row', 'malformed-json'] as const)('refuses %s at the bounded decoder boundary', async (failure) => {
    const fixture = createJournalFixture();
    const bytes = failure === 'invalid-utf8'
        ? new Uint8Array([255, 10])
        : failure === 'truncated-line'
        ? fixture.bytes.subarray(0, fixture.bytes.length - 1)
        : failure === 'oversized-row'
        ? encoder.encode('x'.repeat(1024 * 1024 + 1))
        : encoder.encode('{broken}\n');
    expect((await readRtcB06Journal(toJournalChunks(bytes, 1024), fixture.boundaries)).left).toBeDefined();
});

it('stops at the last complete terminal marker without reading a racing append tail', async () => {
    const fixture = createJournalFixture();
    const bytes = new Uint8Array([...fixture.bytes, ...encoder.encode('{unwritten-tail')]);
    expect((await readRtcB06Journal(toJournalChunks(bytes, bytes.length), fixture.boundaries)).right?.bytes).toBe(fixture.bytes.length);
});

it('streams more than twenty thousand rows per runtime without treating a suffix or scan limit as complete', async () => {
    const fixture = createJournalFixture();
    const terminal = 20010;
    const boundaries = fixture.boundaries.map((boundary) => ({
        ...boundary,
        currentHistory: {
            ...boundary.currentHistory,
            totalEvents: terminal,
            retainedEvents: 64,
            evictedEvents: terminal - 64,
            evictedThroughEpochMs: terminal,
            countsByKind: { ...kinds, event: terminal - 2, result: 2 }
        }
    }));
    async function* fullJournal() {
        for (const boundary of boundaries) {
            yield encoder.encode(
                JSON.stringify({
                    kind: 'step-result',
                    status: 'SUCCESS',
                    action: 'health',
                    name: boundary.admissionCommandId,
                    commandId: boundary.admissionCommandId,
                    agentId: boundary.agentId,
                    actual: { stats: { eventHistory: boundary.initialHistory } }
                }) + '\n'
            );
            for (let ordinal = 4; ordinal <= terminal; ordinal++) {
                yield encoder.encode(
                    JSON.stringify({
                        kind: 'rtc-diagnostic',
                        status: 'event',
                        agentId: boundary.agentId,
                        value: {
                            eventId: `event-${ordinal}`,
                            kind: 'event',
                            topic: 'rallar.browser',
                            atEpochMs: ordinal,
                            history: { runtimeId: boundary.currentHistory.runtimeId, generation: 1, ordinal }
                        }
                    }) + '\n'
                );
            }
            yield encoder.encode(
                JSON.stringify({
                    kind: 'step-result',
                    status: 'SUCCESS',
                    action: 'health',
                    name: boundary.healthCommandId,
                    commandId: boundary.healthCommandId,
                    agentId: boundary.agentId,
                    actual: { stats: { eventHistory: boundary.currentHistory } }
                }) + '\n'
            );
        }
    }
    const result = await readRtcB06Journal(fullJournal(), boundaries);
    expect(result.left).toBeUndefined();
    expect(result.right?.rows).toBe(60027);
    expect(result.right?.agents.map((agent) => agent.capturedRows)).toEqual([20007, 20007, 20007]);
});

it('classifies the canonical sequence-free control stats and report rows without fabricating runtime ordinals', async () => {
    const fixture = createJournalFixture();
    const generated = [
        {
            kind: 'rtc-diagnostic',
            status: 'stats',
            agentId: 'a',
            value: {
                eventId: 'control-stats-0',
                kind: 'stats',
                topic: 'rallar.bb.stats',
                atEpochMs: 1,
                payload: {
                    atEpochMs: 1,
                    status: 'running',
                    counters: { commands: 1, events: 4, failures: 0, messages: 0, diagnostics: 0 },
                    eventHistory: createEventHistory('a', 4)
                }
            }
        },
        {
            kind: 'rtc-diagnostic',
            status: 'report',
            agentId: 'a',
            value: {
                eventId: 'control-report-event-report-1',
                kind: 'report',
                topic: 'rallar.bb.report.final',
                atEpochMs: 1,
                payload: {
                    reportId: 'report-1',
                    runId: 'run',
                    agentId: 'a',
                    summary: { status: 'running', commands: 1, events: 4, failures: 0, reason: 'test' },
                    stats: { eventHistory: createEventHistory('a', 4) }
                }
            }
        }
    ];
    const bytes = encoder.encode([...generated, ...fixture.rows].map((row) => JSON.stringify(row)).join('\n') + '\n');
    expect((await readRtcB06Journal(toJournalChunks(bytes, 17), fixture.boundaries)).right?.rows).toBe(23);
});

it.each(['released', 'deferred', 'rejected'] as const)(
    'interleaves real recorder %s acknowledgements without changing runtime ordinals or counts',
    async (status) => {
        const fixture = createJournalFixture();
        const acknowledgement = controlEventArtifactJsonl({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: 'run',
            agentId: 'a',
            atEpochMs: 1,
            payload: { topic: 'rallar.bb.results.release', requestId: 'retention-release-1-root', status, releasedResults: 1, reason: 'captured' }
        });
        const lines = fixture.rows.map((row) => JSON.stringify(row) + '\n');
        lines.splice(3, 0, acknowledgement);
        const bytes = encoder.encode(lines.join(''));
        const result = await readRtcB06Journal(toJournalChunks(bytes, 17), fixture.boundaries);
        expect(result.left).toBeUndefined();
        expect(result.right).toMatchObject({
            bytes: bytes.length,
            rows: 22,
            agents: ['a', 'b', 'c'].map((agentId) => ({ agentId, capturedRows: 3, countsAfterFirstHealth: { ...kinds, event: 2 } }))
        });
    }
);

it.each(
    [
        'foreign-run',
        'foreign-agent',
        'invalid-count',
        'invalid-status',
        'non-string-status',
        'missing-reason',
        'empty-request',
        'missing-time',
        'runtime-history',
        'runtime-event-id'
    ] as const
)(
    'refuses %s release acknowledgements instead of exempting arbitrary diagnostics',
    async (failure) => {
        const fixture = createJournalFixture();
        const row = JSON.parse(controlEventArtifactJsonl({
            kind: 'diagnostic',
            protocolVersion: 1,
            runId: 'run',
            agentId: 'a',
            atEpochMs: 1,
            payload: { topic: 'rallar.bb.results.release', requestId: 'retention-release-1-root', status: 'released', releasedResults: 1, reason: 'captured' }
        }));
        if (failure === 'foreign-run') {
            row.runId = 'foreign';
        }
        if (failure === 'foreign-agent') {
            row.agentId = 'foreign';
        }
        if (failure === 'invalid-count') {
            row.value.releasedResults = -1;
        }
        if (failure === 'invalid-status') {
            row.value.status = 'unknown';
        }
        if (failure === 'non-string-status') {
            row.value.status = ['released'];
        }
        if (failure === 'missing-reason') {
            delete row.value.reason;
        }
        if (failure === 'empty-request') {
            row.value.requestId = '';
        }
        if (failure === 'missing-time') {
            delete row.atEpochMs;
        }
        if (failure === 'runtime-history') {
            row.value.history = { runtimeId: 'runtime-a', generation: 1, ordinal: 5 };
        }
        if (failure === 'runtime-event-id') {
            row.value.eventId = 'runtime-event';
        }
        const lines = fixture.rows.map((entry) => JSON.stringify(entry) + '\n');
        lines.splice(3, 0, JSON.stringify(row) + '\n');
        expect((await readRtcB06Journal(toJournalChunks(encoder.encode(lines.join('')), 17), fixture.boundaries)).left).toBeDefined();
    }
);
