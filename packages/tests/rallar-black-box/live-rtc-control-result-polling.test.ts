import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { isAdmissibleControlRtcCaptureResult } from '@shared-test/rallar-bb-test/control/control-rtc-capture-evidence.ts';

import { toInitialControlRunState, type ControlRunState } from '../../../apps/rallar-black-box-control-server/src/control-service-state.ts';
import { createDefaultLiveRtcControlHttpFixture, LiveRtcControlHttpFixture } from './live-rtc-control-http-fixture.ts';

describe('live RTC command-result polling projection', () => {
    let httpFixture: LiveRtcControlHttpFixture;
    let run: ControlRunState;

    beforeEach(async () => {
        httpFixture = await createDefaultLiveRtcControlHttpFixture();
        run = toInitialControlRunState('poll/run', 100);
        httpFixture.state.runState = run;
    });

    afterEach(async () => {
        await httpFixture.close();
    });

    it('omits bulky histories on pending and terminal reads while conserving native receipt attribution', async () => {
        const history = {
            kind: 'report' as const,
            protocolVersion: 1 as const,
            runId: run.runId,
            agentId: 'agent-a',
            atEpochMs: 100,
            payload: { bulky: 'history'.repeat(1024) }
        };
        run.events.push(history);
        run.stats.push(history);
        run.reports.push(history);
        run.heartbeats.push({
            kind: 'heartbeat',
            protocolVersion: 1,
            runId: run.runId,
            agentId: 'agent-a',
            atEpochMs: 100,
            status: 'ready',
            identity: { sessionLabel: 'local-fixture', updatedAtEpochMs: 100, region: 'local', provider: 'test', tags: [] }
        });
        run.results.set('unrelated', createHealthResult('unrelated'));
        const waiting = httpFixture.control.executeResult({
            runId: run.runId,
            agentId: 'agent-a',
            commandId: 'connect-native',
            command: { kind: 'rtc.connect', connection: 'manual-a', transport: 'realtime', rallar: { rtcCaptureMode: 'native' } },
            timeoutMs: 2000
        });
        await vi.waitFor(() => expect(httpFixture.state.runReads.length).toBeGreaterThanOrEqual(2));
        run.results.set('connect-native', createNativeConnectResult());
        run.results.set('later-unrelated', createHealthResult('later-unrelated'));

        const result = await waiting;
        expect(result.commandId).toBe('connect-native');
        expect(result.ok).toBe(true);
        expect(result.result?.value).toEqual({
            sessionId: 'session-a',
            connection: 'manual-a',
            rtcCapture: {
                status: 'observed',
                value: {
                    configuration: { mode: 'native', origin: 'step' },
                    application: { status: 'applied', mode: 'native' },
                    connectionId: { status: 'observed', value: 'connection-a' },
                    nativeScopeId: { status: 'observed', value: 'scope-a' },
                    configurationVersion: 1,
                    nativeAvailability: { status: 'observed', value: 'enabled' },
                    nativeCoverage: 'attached'
                }
            }
        });
        for (const read of httpFixture.state.runReads) {
            expect(read.url).toBe('/runs/poll%2Frun?limitEvents=0&limitStats=0&limitReports=0&limitHeartbeats=0');
            expect(read.snapshot.events).toEqual([]);
            expect(read.snapshot.stats).toEqual([]);
            expect(read.snapshot.reports).toEqual([]);
            expect(read.snapshot.heartbeats).toEqual([]);
            expect(read.snapshot.commands.map((queued) => queued.envelope.commandId)).toEqual(['connect-native']);
        }
        const terminal = httpFixture.state.runReads.at(-1)!.snapshot;
        expect(terminal.results.map((envelope) => envelope.commandId)).toEqual(['unrelated', 'connect-native', 'later-unrelated']);
        const nativeEnvelope = terminal.results.find((envelope) => envelope.commandId === 'connect-native')!;
        expect(nativeEnvelope.attribution).toBeUndefined();
        expect(isAdmissibleControlRtcCaptureResult({
            command: terminal.commands[0].envelope,
            envelope: nativeEnvelope,
            commands: terminal.commands,
            results: terminal.results
        })).toBe(true);

        const response = await httpFixture.request.get(`${httpFixture.baseUrl}/runs/poll%2Frun?limitCommands=0`);
        const omittedCommands: ControlRunSnapshot = await response.json();
        expect(omittedCommands.commands).toEqual([]);
        expect(omittedCommands.results.find((envelope) => envelope.commandId === 'connect-native')?.attribution).toEqual({
            status: 'unavailable',
            reason: 'queued-command-not-retained'
        });
    });

    it('keeps concurrent waits independent without narrowing the command or result window', async () => {
        const waits = ['first', 'second'].map((commandId) =>
            httpFixture.control.executeResult({
                runId: run.runId,
                agentId: 'agent-a',
                commandId,
                command: { kind: 'health' },
                timeoutMs: 2000
            })
        );
        await vi.waitFor(() => expect(httpFixture.state.runReads.length).toBeGreaterThanOrEqual(2));
        run.results.set('first', createHealthResult('first'));
        run.results.set('second', createHealthResult('second'));
        run.results.set('last', createHealthResult('last'));
        expect((await Promise.all(waits)).map((result) => result.commandId)).toEqual(['first', 'second']);
        for (const read of httpFixture.state.runReads) {
            const query = new URL(read.url, httpFixture.baseUrl).searchParams;
            expect(query.has('limitCommands')).toBe(false);
            expect(query.has('limitResults')).toBe(false);
        }
        const terminal = httpFixture.state.runReads.at(-1)!.snapshot;
        expect(terminal.commands.map((queued) => queued.envelope.commandId)).toEqual(['first', 'second']);
        expect(terminal.results.map((result) => result.commandId)).toEqual(['first', 'second', 'last']);
        expect(terminal.results.slice(0, 2).every((result) => result.attribution === undefined)).toBe(true);
    });

    it('keeps full event reads and delivery identity controls independent of the result projection', async () => {
        const wrongDelivery = {
            kind: 'event' as const,
            protocolVersion: 1 as const,
            runId: run.runId,
            agentId: 'agent-b',
            atEpochMs: 100,
            payload: { kind: 'message', transport: 'realtime', payload: { data: { matrixId: 'wrong-matrix', deliveryMode: 'direct' } } }
        };
        run.events.push(wrongDelivery);
        let observed = false;
        const waiting = httpFixture.control.waitForMessage({
            runId: run.runId,
            senderAgentId: 'agent-a',
            agentId: 'agent-b',
            transport: 'realtime',
            matrixId: 'direct-a-b',
            deliveryMode: 'direct',
            startedAtMs: 100,
            timeoutMs: 2000
        }).then((duration) => {
            observed = true;
            return duration;
        });
        await vi.waitFor(() => expect(httpFixture.state.runReads.length).toBeGreaterThanOrEqual(2));
        expect(observed).toBe(false);
        run.events.push({
            ...wrongDelivery,
            payload: { kind: 'message', transport: 'realtime', payload: { data: { matrixId: 'direct-a-b', deliveryMode: 'direct' } } }
        });
        run.events.push({ ...run.events[1], agentId: 'agent-c' });
        expect(await waiting).toBe(0);
        expect((await httpFixture.control.fetchRun(run.runId)).events).toHaveLength(3);
        expect(
            await httpFixture.control.unexpectedDeliveryCount({
                runId: run.runId,
                scenarios: [{
                    matrixId: 'direct-a-b',
                    transport: 'realtime',
                    deliveryMode: 'direct',
                    senderAgentId: 'agent-a',
                    expectedAgentIds: ['agent-b'],
                    allowedAgentIds: ['agent-b']
                }]
            })
        ).toBe(1);
        expect(httpFixture.state.runReads.every((read) => read.url === '/runs/poll%2Frun')).toBe(true);
    });

    it.each(['missing', 'wrong-command'])('retains the command timeout for a %s result', async (variant) => {
        if (variant === 'wrong-command') {
            run.results.set('unrelated', createHealthResult('unrelated'));
        }
        await expect(httpFixture.control.executeResult({
            runId: run.runId,
            agentId: 'agent-a',
            commandId: 'requested',
            command: { kind: 'health' },
            timeoutMs: 150
        })).rejects.toThrow();
        expect(httpFixture.state.runReads.length).toBeGreaterThan(0);
    });

    it('returns the exact failed result and preserves executeOk rejection', async () => {
        const failed: ControlResultEnvelope = {
            kind: 'result',
            protocolVersion: 1,
            runId: run.runId,
            agentId: 'agent-a',
            commandId: 'failed-command',
            ok: false,
            error: { code: 'fixture-failure', message: 'Command failed.' }
        };
        run.results.set(failed.commandId, failed);
        const command = { runId: run.runId, agentId: 'agent-a', commandId: 'failed-command', command: { kind: 'health' as const }, timeoutMs: 150 };
        expect(await httpFixture.control.executeResult(command)).toEqual({
            agentId: 'agent-a',
            commandId: 'failed-command',
            ok: false,
            error: { code: 'fixture-failure', message: 'Command failed.' }
        });
        await expect(httpFixture.control.executeOk(command)).rejects.toThrow('to succeed');
    });
});

function createHealthResult(commandId: string): ControlResultEnvelope {
    return { kind: 'result', protocolVersion: 1, runId: 'poll/run', agentId: 'agent-a', commandId, ok: true };
}

function createNativeConnectResult(): ControlResultEnvelope {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: 'poll/run',
        agentId: 'agent-a',
        commandId: 'connect-native',
        ok: true,
        result: {
            commandId: 'connect-native',
            kind: 'rtc.connect',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 100,
            endedAtEpochMs: 110,
            durationMs: 10,
            value: {
                sessionId: 'session-a',
                connection: 'manual-a',
                rtcCapture: {
                    status: 'observed',
                    value: {
                        configuration: { mode: 'native', origin: 'step' },
                        application: { status: 'applied', mode: 'native' },
                        connectionId: { status: 'observed', value: 'connection-a' },
                        nativeScopeId: { status: 'observed', value: 'scope-a' },
                        configurationVersion: 1,
                        nativeAvailability: { status: 'observed', value: 'enabled' },
                        nativeCoverage: 'attached'
                    }
                }
            }
        }
    };
}
