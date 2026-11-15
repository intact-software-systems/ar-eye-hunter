import type { ControlEventEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { describe, expect, it } from 'vitest';

import {
    hasRuntimeDiagnostic,
    type RuntimeDiagnosticExpectation
} from '../../../../tests/playwright/rallar-black-box/distributed-recipes/runtime-observations.ts';

const CONTROL_RUN_RETAINED_EVENTS = 2_000;
const WARNINGS_LOGGED_AT_MS = 50_000;

const expectation: RuntimeDiagnosticExpectation = {
    agentId: 'agent-b',
    diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
    transport: 'ws',
    pattern: 'unhandled-ws-message',
    group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'room-1' },
    recordedFromEpochMs: WARNINGS_LOGGED_AT_MS,
    connection: 'realtime-run-1'
};

function toWarning(atEpochMs: number): ControlEventEnvelope {
    return {
        kind: 'diagnostic',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-b',
        atEpochMs,
        payload: {
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            payload: {
                diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                severity: 'warning',
                connection: 'realtime-run-1',
                roomId: 'room-1',
                scope: { applicationId: 'rallar-server', workspaceId: 'default' },
                data: { pattern: 'unhandled-ws-message', source: 'console.warn' }
            }
        }
    };
}

function toMessage(atEpochMs: number): ControlEventEnvelope {
    return {
        kind: 'event',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-a',
        atEpochMs,
        payload: { kind: 'message', transport: 'realtime', payload: { data: {} } }
    };
}

/** The tail a control run keeps once it has recorded more events than it retains. */
function toRetainedTail(events: readonly ControlEventEnvelope[]): readonly ControlEventEnvelope[] {
    return events.slice(-CONTROL_RUN_RETAINED_EVENTS);
}

describe('runtime diagnostic wait', () => {
    it('finds the warning recorded after the stamp in a run that already retains its full window', () => {
        const before = Array.from({ length: 2_200 }, (_, index) => toMessage(index));
        const events = toRetainedTail([...before, toWarning(WARNINGS_LOGGED_AT_MS)]);
        expect(events).toHaveLength(CONTROL_RUN_RETAINED_EVENTS);

        expect(hasRuntimeDiagnostic(events, expectation)).toBe(true);
    });

    it('ignores the same warning recorded before the stamp', () => {
        const events = toRetainedTail([
            ...Array.from({ length: 1_000 }, (_, index) => toMessage(index)),
            toWarning(WARNINGS_LOGGED_AT_MS - 1),
            ...Array.from({ length: 1_500 }, (_, index) => toMessage(WARNINGS_LOGGED_AT_MS + index))
        ]);
        expect(events).toContainEqual(toWarning(WARNINGS_LOGGED_AT_MS - 1));

        expect(hasRuntimeDiagnostic(events, expectation)).toBe(false);
    });
});
