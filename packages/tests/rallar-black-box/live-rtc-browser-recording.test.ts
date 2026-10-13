import { expect, it } from 'vitest';

import { buildLiveRtcAgentDiagnostics } from '../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { LiveRtcBrowserRecording } from '../../../tests/playwright/rallar-black-box/live-rtc-browser-recording.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';

const agents = ['a', 'b', 'c'].map((agentId) => ({ agentId, page: {} }));
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
            result: { value: { browserDiagnostics: receipt } }
        })
    };
    const recording = new LiveRtcBrowserRecording(control);
    await recording.admit({ runId: 'run', agents, mode: 'disabled' });
    const current = {
        ok: true,
        agentId: 'c',
        commandId: 'checkpoint-c',
        result: { value: { browserDiagnostics: { ...receipt, omittedRoutineBrowserDiagnostics: 50 } } }
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
