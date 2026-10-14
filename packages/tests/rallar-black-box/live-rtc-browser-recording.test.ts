import { expect, it } from 'vitest';

import { buildLiveRtcAgentDiagnostics } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { LiveRtcBrowserRecording } from '../../../tests/playwright/rallar-black-box/live-rtc-browser-recording.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

const agents = ['a', 'b', 'c'].map((agentId) => ({ agentId, page: {}, eventHistory: { mode: 'recent' as const, maxEvents: 64 } }));
const receipt = { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: 1, forwardedBrowserDiagnostics: 2 };
it.each(['missing', 'wrong-mode', 'wrong-agent', 'malformed'])('blocks all initial mutations when C Health is %s', async (failure) => {
    const commands: string[] = [];
    const recording = new LiveRtcBrowserRecording({
        executeOk: async (input) => {
            commands.push(input.command.kind);
            return {
                ok: true,
                agentId: input.agentId === 'c' && failure === 'wrong-agent' ? 'a' : input.agentId,
                commandId: input.commandId,
                result: {
                    value: {
                        eventHistory: history(input.agentId, 1),
                        browserDiagnostics: input.agentId !== 'c' ? receipt : failure === 'missing'
                            ? null
                            : failure === 'wrong-mode'
                            ? { ...receipt, routineBrowserDiagnostics: 'enabled' }
                            : failure === 'malformed'
                            ? { ...receipt, forwardedBrowserDiagnostics: 0.5 }
                            : receipt
                    }
                }
            };
        }
    });
    await expect((async () => {
        await recording.admit({ runId: 'run', agents, mode: 'disabled' });
        commands.push('group.create', 'Connect');
    })()).rejects.toThrow(/recording/i);
    expect(commands).toEqual(['health', 'health', 'health']);
});
it('retains initial receipt and monotonic counters on the same page, refusing a replacement page', async () => {
    const control = {
        executeOk: async (input: LiveRtcControlClient.ExecuteInput) => ({
            ok: true,
            agentId: input.agentId,
            commandId: input.commandId,
            result: { value: { browserDiagnostics: receipt, eventHistory: history(input.agentId, 1) } }
        })
    };
    const recording = new LiveRtcBrowserRecording(control);
    await recording.admit({ runId: 'run', agents, mode: 'disabled' });
    const current = {
        ok: true,
        agentId: 'c',
        commandId: 'checkpoint-c',
        result: { value: { browserDiagnostics: { ...receipt, omittedRoutineBrowserDiagnostics: 50 }, eventHistory: history('c', 100) } }
    };
    recording.assertAgent(agents[2]!);
    expect(recording.observe('run', current)).toMatchObject({
        browserDiagnosticsAdmission: { runId: 'run', agentId: 'c', commandId: 'browser-recording-admission-c', receipt },
        browserDiagnosticsHealth: { runId: 'run', agentId: 'c', commandId: 'checkpoint-c' }
    });
    expect(() => recording.assertAgent({ agentId: 'c', page: {} })).toThrow(/page/i);
    expect(() => recording.observe('run', { ...current, result: { value: { browserDiagnostics: receipt } } })).toThrow(/recording/i);
});

it('preserves the actual root Health receipt in checkpoint details', () => {
    const result = buildLiveRtcAgentDiagnostics('c', {
        browserDiagnostics: receipt,
        rallar: {
            rtcStatus: { activePeerIds: [], readyPeerIds: [] },
            rtcDiagnostics: { generatedAtEpochMs: 1, peers: [], peerCount: 0, connectedPeerCount: 0, relayPeerCount: 0 }
        }
    });
    expect(result.details).toMatchObject({ browserDiagnostics: receipt });
});

it.each(['missing', 'policy', 'identity', 'duplicate-runtime', 'gap'])('refuses %s admitted history before initial mutations', async (failure) => {
    const recording = new LiveRtcBrowserRecording({
        executeOk: async (input) => ({
            ok: true,
            agentId: input.agentId,
            commandId: input.commandId,
            result: {
                value: {
                    browserDiagnostics: receipt,
                    eventHistory: input.agentId !== 'c'
                        ? history(input.agentId, 1)
                        : failure === 'missing'
                        ? null
                        : failure === 'policy'
                        ? { ...history('c', 1), policy: { mode: 'full' } }
                        : failure === 'identity'
                        ? history('a', 1)
                        : failure === 'duplicate-runtime'
                        ? {
                            ...history('c', 1),
                            runtimeId: 'runtime-a',
                            capture: { ...history('c', 1).capture, start: { runtimeId: 'runtime-a', generation: 0, ordinal: 1 } }
                        }
                        : { ...history('c', 1), capture: { status: 'gap' } }
                }
            }
        })
    });
    await expect(
        recording.admit({ runId: 'run', agents: agents.map((agent) => ({ ...agent, eventHistory: { mode: 'recent', maxEvents: 64 } })), mode: 'disabled' })
    ).rejects.toThrow(/recording/i);
});

it('snapshots admitted history and refuses a substituted lifetime at a subsequent checkpoint', async () => {
    const initial = history('c', 1);
    const recording = new LiveRtcBrowserRecording({
        executeOk: async (input) => ({
            ok: true,
            agentId: input.agentId,
            commandId: input.commandId,
            result: { value: { browserDiagnostics: receipt, eventHistory: input.agentId === 'c' ? initial : history(input.agentId, 1) } }
        })
    });
    await recording.admit({ runId: 'run', agents: agents.map((agent) => ({ ...agent, eventHistory: { mode: 'recent', maxEvents: 64 } })), mode: 'disabled' });
    initial.countsByKind.event = 999;
    initial.capture.identity.runId = 'mutated';
    const evidence = recording.observe('run', {
        ok: true,
        agentId: 'c',
        commandId: 'checkpoint',
        result: { value: { browserDiagnostics: receipt, eventHistory: history('c', 100) } }
    });
    expect(evidence?.browserDiagnosticsAdmission.eventHistory).toMatchObject({
        totalEvents: 1,
        countsByKind: { event: 1 },
        capture: { identity: { runId: 'run' } }
    });
    expect(() =>
        recording.observe('run', {
            ok: true,
            agentId: 'c',
            commandId: 'next',
            result: { value: { browserDiagnostics: receipt, eventHistory: { ...history('c', 101), generation: 1 } } }
        })
    ).toThrow(/continuity/);
});

function history(agentId: string, totalEvents: number) {
    return {
        runtimeId: `runtime-${agentId}`,
        generation: 0,
        policy: { mode: 'recent', maxEvents: 64 },
        totalEvents,
        retainedEvents: Math.min(totalEvents, 64),
        evictedEvents: Math.max(0, totalEvents - 64),
        evictedThroughEpochMs: totalEvents > 64 ? totalEvents : null,
        countsByKind: { event: totalEvents, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
        reconnects: 0,
        capture: { status: 'continuous', identity: { runId: 'run', agentId }, start: { runtimeId: `runtime-${agentId}`, generation: 0, ordinal: 1 } }
    };
}
