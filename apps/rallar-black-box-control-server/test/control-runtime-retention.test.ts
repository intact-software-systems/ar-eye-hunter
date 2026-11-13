import { expect, test } from 'bun:test';

import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlEventEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';

import { trimControlRunEvidence } from '../src/control-runtime-retention.ts';
import { toInitialControlRunState, type ControlRunState } from '../src/control-service-state.ts';

test('unbounded and within-limit retention keeps each retained evidence array without copying it', () => {
    for (const bounds of [{}, { events: 10, stats: 10, reports: 10, heartbeats: 10 }]) {
        const run = toRunWithEvents(3);
        const before = { events: run.events, stats: run.stats, reports: run.reports, heartbeats: run.heartbeats };

        trimControlRunEvidence(run, [], bounds);

        expect(run.events).toBe(before.events);
        expect(run.stats).toBe(before.stats);
        expect(run.reports).toBe(before.reports);
        expect(run.heartbeats).toBe(before.heartbeats);
        expect(run.events.length).toEqual(3);
    }
});

test('bounded retention keeps the newest events up to the limit', () => {
    const run = toRunWithEvents(5);

    trimControlRunEvidence(run, [], { events: 2 });

    expect(run.events.map((event) => event.eventId)).toEqual(['event-3', 'event-4']);
});

function toRunWithEvents(count: number): ControlRunState {
    const run = toInitialControlRunState('run-1', 1_000);
    run.events.push(...Array.from({ length: count }, (_, index) => toEvent(`event-${index}`)));
    run.stats.push(toEvent('stats-0'));
    return run;
}

function toEvent(eventId: string): ControlEventEnvelope {
    return {
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_000,
        eventId,
        payload: { eventId, kind: 'event', topic: 'rallar.bb.test', atEpochMs: 1_000, severity: 'info', payload: {} }
    };
}
