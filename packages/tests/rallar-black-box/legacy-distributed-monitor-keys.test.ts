// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DistributedRunMonitor } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { DistributedRunMonitorPanel } from '../../../apps/rallar-black-box/src/legacy/runner/distributed/DistributedRunMonitorPanel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('legacy distributed monitor row identity', () => {
    afterEach(() => vi.restoreAllMocks());

    it('renders repeated same-agent event ids without duplicate React keys', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);

        await act(async () => {
            root.render(createElement(DistributedRunMonitorPanel, {
                monitor: monitorWithAgentLocalEventIds()
            }));
        });

        const duplicateKeyErrors = consoleError.mock.calls.filter((call) => call.some((value) => String(value).includes('same key')));
        expect(duplicateKeyErrors).toEqual([]);

        await act(async () => root.unmount());
        container.remove();
    });
});

function monitorWithAgentLocalEventIds(): DistributedRunMonitor {
    const events = [
        { agentId: 'agent-a', label: 'before restart' },
        { agentId: 'agent-a', label: 'after restart' },
        { agentId: 'agent-b', label: 'other agent' }
    ] as const;
    return {
        distributedRunId: 'distributed-run-a',
        state: 'passed',
        commandCounts: {
            total: 0,
            stage: 0,
            barrier: 0,
            start: 0,
            cancel: 0,
            completed: 0,
            failed: 0,
            pending: 0
        },
        resultCounts: { total: 0, ok: 0, failed: 0 },
        compositeCounts: {
            total: 0,
            passed: 0,
            failed: 0,
            childResults: 0,
            composite: 0,
            leaf: 0
        },
        diagnosticCounts: {
            total: 3,
            info: 0,
            warning: 3,
            error: 0,
            ws: 3,
            rtc: 0,
            http: 0,
            runtime: 0
        },
        latency: { count: 0 },
        artifact: {
            status: 'not-loaded',
            fileCount: 0,
            message: 'Not loaded'
        },
        timeline: events.map(({ agentId, label }) => ({
            id: 'event-event-1',
            atEpochMs: 1,
            kind: 'event',
            label,
            tone: 'muted',
            agentId
        })),
        agentProgress: [],
        recipeProgress: [],
        readiness: [],
        failures: [],
        events: events.map(({ agentId, label }) => ({
            eventId: 'event-1',
            atEpochMs: 1,
            kind: 'event',
            agentId,
            summary: label,
            payloadSummary: label
        })),
        runtimeDiagnostics: events.map(({ agentId, label }) => ({
            eventId: 'event-1',
            atEpochMs: 1,
            severity: 'warning',
            agentId,
            transport: 'ws',
            topic: 'runtime.warning',
            diagnosticTypeId: 'runtime.warning',
            message: label,
            summary: label,
            payloadSummary: label,
            correlatedFailureKeys: []
        })),
        compositeDrilldowns: []
    };
}
