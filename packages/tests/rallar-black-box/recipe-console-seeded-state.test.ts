import { describe, expect, it, vi } from 'vitest';
import { createRecipeConsoleSeedState } from '../../../apps/rallar-black-box/src/recipe-console/data/seeded-console-state.ts';

describe('Recipe Console seeded state', () => {
    it('builds Execute from the shared RTC stability fixture and canonical sample targets', () => {
        const { execute } = createRecipeConsoleSeedState();

        expect(execute.selectedFixture.fixtureId).toBe('rtc-realtime-stability');
        expect(execute.catalogRows.map(row => row.fixtureId)).toContain('rtc-realtime-stability');
        expect(execute.commandPreview.label).toBe('5 manifest commands - 25 stream frames');
        expect(execute.targetRows.map(row => [row.agentId, row.status, row.targetable])).toEqual([
            ['seed-agent-a', 'matched', true],
            ['seed-agent-b', 'matched', true],
        ]);
        expect(execute.defaultTargetIds).toEqual(['seed-agent-a', 'seed-agent-b']);
        expect(execute.controlConnectivity).toBe('required-not-checked');
        expect(execute.group).toEqual({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'seed-room',
        });

        const expectedGroup = {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'seed-room',
        };
        const ensureGroup = execute.selectedFixture.recipe.commands.find(
            command => command.commandId === 'rtc-realtime-ensure-group',
        );
        const ensureMember = execute.selectedFixture.recipe.commands.find(
            command => command.commandId === 'rtc-realtime-ensure-member',
        );
        const connect = execute.selectedFixture.recipe.commands.find(
            command => command.commandId === 'rtc-realtime-connect',
        );
        expect(ensureGroup?.metadata).toMatchObject({ group: expectedGroup });
        expect(ensureMember?.metadata).toMatchObject({ group: expectedGroup });
        expect(connect).toMatchObject({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            roomId: 'seed-room',
            roomRef: expectedGroup,
        });
    });

    it('builds Monitor from the canonical failed-command evidence in failure-first order', () => {
        const { monitor } = createRecipeConsoleSeedState();

        expect(monitor.seed.id).toBe('failed-command');
        expect(monitor.seed.distributedRun.distributedRunId).toBe('seed-failed-command');
        expect(monitor.seed.controlRun.runId).toBe('seed-control-failed-command');
        expect(monitor.seed.distributedRun.rollup.summary).toMatchObject({
            participants: 2,
            failedParticipants: 1,
        });
        expect(monitor.monitor.commandCounts).toMatchObject({ total: 4, failed: 1 });
        expect(monitor.failureLedger.map(row => [row.code, row.message])).toEqual([
            ['SYNTHETIC_RECIPE_FAILED', 'Receiver did not observe the RTC payload.'],
            ['SYNTHETIC_ASSERTION_FAILED', 'Receiver did not observe the RTC payload.'],
        ]);
        expect(monitor.selectedCommandFailure).toMatchObject({
            kind: 'command',
            key: 'seed-start-receiver',
            commandId: 'seed-start-receiver',
            agentId: 'seed-agent-b',
        });
        expect(monitor.monitor.runtimeDiagnostics).toHaveLength(1);
        expect(monitor.monitor.runtimeDiagnostics[0]?.correlatedFailureKeys).toEqual([
            'seed-start-receiver',
        ]);
        expect(monitor.verdict).toMatchObject({
            title: 'Outcome failed',
            likelyCause: 'Receiver did not observe the RTC payload.',
            nextAction:
                'Open command seed-start-receiver on agent seed-agent-b, inspect the command payload/result, and compare sibling agents running the same recipe.',
        });
        expect(monitor.monitor.latency.maxMs).toBe(520);
        expect(monitor.agentProgress).toHaveLength(2);
    });

    it('projects only stable command-duration Tune evidence', () => {
        const { tune } = createRecipeConsoleSeedState();

        expect(tune).toMatchObject({
            seedId: 'high-latency-rtc',
            distributedRunId: 'seed-high-latency-rtc',
            controlRunId: 'seed-control-high-latency-rtc',
            state: 'passed',
            rtcTimelineAvailable: false,
        });
        expect(tune.agentMeans.map(row => row.meanMs)).toEqual([112.5, 1010, 1190]);
        expect(tune.percentiles).toEqual({
            p50Ms: 1010,
            p95Ms: 1190,
            p99Ms: 1190,
            maxMs: 1190,
        });
        expect(tune.histogram.map(bucket => bucket.count)).toEqual([1, 0, 0, 2]);
        expect(tune.points).toHaveLength(3);
        expect(tune.matrixCells).toHaveLength(18);
        expect(tune.emptyReasons).toContain('No RTC timeline events yet');
        expect(tune).not.toHaveProperty('diagnostics');
        expect(tune).not.toHaveProperty('performance');
        expect(tune).not.toHaveProperty('timeseries');
        expect(tune).not.toHaveProperty('phaseSpans');
    });

    it('does not leak clock-bearing diagnostics into deterministic models', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime('2026-07-11T08:00:00.000Z');
            const first = createRecipeConsoleSeedState();
            vi.setSystemTime('2036-07-11T08:00:00.000Z');
            const second = createRecipeConsoleSeedState();

            expect(second).toEqual(first);
        } finally {
            vi.useRealTimers();
        }
    });
});
