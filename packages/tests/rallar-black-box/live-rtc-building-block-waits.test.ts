import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { computeEnqueuedCommandWaitMs } from '@shared-test/rallar-bb-test/browser-test-budgets/compute-command-result-wait-ms.ts';
import { GROUP_MEMBERSHIP_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/group-membership-waits.ts';
import { LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-agent-opening-waits.ts';
import { LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-control-waits.ts';
import {
    ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS,
    DELIVERY_MATRIX_BOUNDED_WAITS_MS,
    REALTIME_DELIVERY_MATRIX_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-delivery-matrix-waits.ts';
import {
    MATRIX_SEND_RESULT_WAIT_MS,
    MESSAGES_PROBES_BOUNDED_WAITS_MS,
    WS_AGENT_OPEN_SEND_CLOSE_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-delivery-waits.ts';
import {
    FORMATION_RECONNECT_BOUNDED_WAITS_MS,
    FORMATION_RUN_BOUNDED_WAITS_MS
} from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-formation-waits.ts';
import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import { SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/settled-trio-retirement-bounded-waits-ms.ts';
import type { RtcBaselineJson } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import { LiveRtcBrowserRecording } from '../../../tests/playwright/rallar-black-box/live-rtc-browser-recording.ts';
import {
    resolveLiveRtcResultPollTimeoutMs,
    type LiveRtcControlClient
} from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';
import { LiveRtcLayoutSwitchOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-layout-switch-operations.ts';
import {
    LAYOUT_SWITCH_STREAM_DURATION_MS,
    LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS
} from '../../../tests/playwright/rallar-black-box/live-rtc-layout-switch-test-timeouts.ts';
import {
    createCountedPage,
    measureBoundedWaitsMs,
    settleUnderFakeTimers,
    spendBoundedWait,
    useBoundedWaitClock
} from './bounded-wait-clock-fixture.ts';
import { RecordingLiveRtcControl } from './recording-live-rtc-control-fixture.ts';

vi.mock('@playwright/test', async (importOriginal) => {
    const { toCountedPlaywrightModule } = await import('./bounded-wait-clock-fixture.ts');
    return toCountedPlaywrightModule(await importOriginal(), FULL_STACK_EXPECT_TIMEOUT_MS);
});

const operations = createLiveRtcDeliveryOperations({
    almDiagnostics: true,
    apiBaseUrl: 'http://localhost:18080',
    applicationId: 'app',
    workspaceId: 'work',
    messagesRtcTypeId: 'type',
    messagesRtcTopicId: 'topic',
    formation: createLiveRtcFormationOperations()
});

const run = { runId: 'run', groupId: 'room', suffix: 'counted' };

useBoundedWaitClock();

function createControl(): RecordingLiveRtcControl {
    return new RecordingLiveRtcControl(undefined, spendBoundedWait);
}

/** The recorder's agents with counted pages, as the delivery matrix observes its inboxes on them. */
function toPagedAgents(
    control: RecordingLiveRtcControl
): readonly [LiveRtcControlClient.Agent, LiveRtcControlClient.Agent, LiveRtcControlClient.Agent] {
    const [a, b, c] = control.agents.map((agent) => ({
        ...agent,
        page: createCountedPage(),
        context: { close: async () => {} }
    }));
    return [a, b, c];
}

/** A health that admits an agent's browser recording: its diagnostics receipt and its continuous full history. */
function toAdmittedHealth(agentId: string): RtcBaselineJson {
    return {
        browserDiagnostics: { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: 0, forwardedBrowserDiagnostics: 0 },
        stats: {
            eventHistory: {
                runtimeId: `runtime-${agentId}`,
                generation: 0,
                policy: { mode: 'full' },
                totalEvents: 1,
                retainedEvents: 1,
                evictedEvents: 0,
                evictedThroughEpochMs: null,
                countsByKind: { event: 1, diagnostic: 0, message: 0, stats: 0, report: 0, result: 0, state: 0 },
                reconnects: 0,
                capture: {
                    status: 'continuous',
                    identity: { runId: run.runId, agentId },
                    start: { runtimeId: `runtime-${agentId}`, generation: 0, ordinal: 1 }
                }
            }
        }
    };
}

/** The not-yet-in-sync NACK B returns to A for the probe's sent message. */
function toProbeNackFrame(sessions: Readonly<Record<'A' | 'B' | 'C', string>>): string {
    const nack = { msgId: 'attempted-message', reason: 'not-yet-in-sync', fromPeerId: sessions.B, toPeerId: sessions.A };
    return JSON.stringify({ payload: { typeId: 'al.control.nack.v4', resource: JSON.stringify(nack) } });
}

async function formTrio(control: RecordingLiveRtcControl, transport: 'realtime' | 'messages.rtc') {
    return await settleUnderFakeTimers(() =>
        operations.runGroupFormation({
            ...run,
            control,
            agents: control.agents,
            transport,
            readinessScope: 'owner'
        })
    );
}

describe('the live RTC building blocks wait what their derivations count', () => {
    it('creates the group and joins its two other members within the membership\'s bounded waits', async () => {
        const control = createControl();

        expect(await measureBoundedWaitsMs(() => operations.setupGroupMembership({ ...run, control, owner: control.agents[0], members: control.agents }))).toBe(
            GROUP_MEMBERSHIP_BOUNDED_WAITS_MS
        );
    });

    it.each(['owner', 'all'] as const)('forms the trio with %s readiness within the formation run\'s bounded waits', async (scope) => {
        const control = createControl();

        expect(
            await measureBoundedWaitsMs(() =>
                operations.runGroupFormation({
                    ...run,
                    control,
                    agents: control.agents,
                    transport: 'messages.rtc',
                    readinessScope: scope
                })
            )
        ).toBe(FORMATION_RUN_BOUNDED_WAITS_MS);
    });

    it('reconnects a member and waits for the trio\'s readiness within the reconnect\'s bounded waits', async () => {
        const control = createControl();
        const formation = await formTrio(control, 'messages.rtc');

        expect(
            await measureBoundedWaitsMs(() =>
                operations.reconnectAndWaitForPeerReadiness({
                    ...run,
                    control,
                    reconnectingAgent: control.agents[2],
                    survivingAgents: [control.agents[0], control.agents[1]],
                    survivingSessionIds: [formation.sessions.A, formation.sessions.B],
                    transport: 'messages.rtc'
                })
            )
        ).toBe(FORMATION_RECONNECT_BOUNDED_WAITS_MS);
    });

    it.each([
        { transport: 'realtime' as const, boundedWaitsMs: REALTIME_DELIVERY_MATRIX_BOUNDED_WAITS_MS },
        { transport: 'messages.rtc' as const, boundedWaitsMs: DELIVERY_MATRIX_BOUNDED_WAITS_MS }
    ])('runs the $transport delivery matrix within its bounded waits', async ({ transport, boundedWaitsMs }) => {
        const control = Object.assign(createControl(), { readyPeerIds: () => ['session-B-1', 'session-C-1'] });

        expect(await measureBoundedWaitsMs(() => operations.runDeliveryMatrix({ ...run, control, agents: toPagedAgents(control), transport }))).toBe(
            boundedWaitsMs
        );
    });

    it('runs every delivery permutation within its bounded waits', async () => {
        const control = createControl();

        expect(await measureBoundedWaitsMs(() => operations.runAllDeliveryPermutations({ ...run, control, agents: control.agents, transport: 'messages.rtc' })))
            .toBe(ALL_DELIVERY_PERMUTATIONS_BOUNDED_WAITS_MS);
    });

    it('retires the settled trio within its bounded waits', async () => {
        const control = createControl();
        const formation = await formTrio(control, 'messages.rtc');

        expect(
            await measureBoundedWaitsMs(() =>
                operations.closeAndResetSettledAgentTrio({
                    ...run,
                    control,
                    agents: control.agents,
                    sessions: formation.sessions
                })
            )
        ).toBe(SETTLED_TRIO_RETIREMENT_BOUNDED_WAITS_MS);
    });

    it('sends a matrix payload within the send\'s result wait', async () => {
        const control = createControl();

        expect(
            await measureBoundedWaitsMs(() =>
                operations.sendMatrixPayload({
                    ...run,
                    control,
                    sender: control.agents[0],
                    transport: 'messages.rtc',
                    deliveryMode: 'broadcast',
                    matrixId: 'counted-send'
                })
            )
        ).toBe(MATRIX_SEND_RESULT_WAIT_MS);
    });

    it('opens, sends and closes each WebSocket agent within its bounded waits', async () => {
        const control = createControl();

        expect(await measureBoundedWaitsMs(() => operations.runWebSocketOpenSendCloseMatrix({ ...run, control, agents: control.agents }))).toBe(
            control.agents.length * WS_AGENT_OPEN_SEND_CLOSE_BOUNDED_WAITS_MS
        );
    });

    it('closes and resets an agent within its bounded waits', async () => {
        const control = createControl();

        expect(await measureBoundedWaitsMs(() => operations.closeAndResetAgents({ ...run, control, agents: [control.agents[0]] }))).toBe(
            LIVE_RTC_CLOSE_AND_RESET_BOUNDED_WAITS_MS
        );
    });

    it('admits each agent\'s browser recording within the admission\'s bounded waits', async () => {
        const recording = new LiveRtcBrowserRecording({
            executeOk: async (input) => {
                await spendBoundedWait(computeEnqueuedCommandWaitMs(resolveLiveRtcResultPollTimeoutMs(input)));
                return {
                    ok: true,
                    agentId: input.agentId,
                    commandId: input.commandId,
                    result: { value: toAdmittedHealth(input.agentId) }
                };
            }
        });

        expect(await measureBoundedWaitsMs(() => recording.admit({ runId: run.runId, mode: 'disabled', agents: toPagedAgents(createControl()) }))).toBe(
            LIVE_RTC_RECORDING_ADMISSION_BOUNDED_WAITS_MS
        );
    });

    it('runs the NACK probe and the closed transport probe within the probes\' bounded waits', async () => {
        const control = createControl();
        const formation = await formTrio(control, 'messages.rtc');
        const a = { ...toPagedAgents(control)[0], page: createCountedPage(() => [toProbeNackFrame(formation.sessions)]) };
        const probeControl = Object.assign(control, {
            requireSentMessageId: () => 'attempted-message',
            recordReceivedNack: async () => undefined,
            captureNackFailure: async () => {
                throw new Error('The counted probe has no failure to capture.');
            }
        });

        expect(
            await measureBoundedWaitsMs(async () => {
                await operations.runNackProbe({
                    ...run,
                    control: probeControl,
                    testInfo: { attach: async () => undefined },
                    agent: a,
                    senderSessionId: formation.sessions.A,
                    targetAgentId: control.agents[1].agentId,
                    targetSessionId: formation.sessions.B
                });
                await operations.expectClosedTransportFailure({
                    ...run,
                    control,
                    agent: a,
                    targetSessionId: formation.sessions.B
                });
            })
        ).toBe(MESSAGES_PROBES_BOUNDED_WAITS_MS);
    });
});

describe('the layout-switch operations wait what their derivation counts', () => {
    function createLayoutSwitchOperations(control: RecordingLiveRtcControl): LiveRtcLayoutSwitchOperations {
        return new LiveRtcLayoutSwitchOperations({
            control: Object.assign(control, {
                fetchRun: async () => ({ agents: [], commands: [], results: [], events: [], stats: [], reports: [] })
            }),
            formation: createLiveRtcFormationOperations(),
            runId: run.runId,
            roomRef: { applicationId: 'app', workspaceId: 'work', groupId: run.groupId },
            suffix: run.suffix,
            owner: toPagedAgents(control)[0],
            messagesRtc: { typeId: 'type', topicId: 'topic' }
        });
    }

    it('reads the served overlap, writes the topology, reads a health and streams within their bounded waits', async () => {
        const control = createControl();
        await formTrio(control, 'messages.rtc');
        const layoutSwitch = createLayoutSwitchOperations(control);
        const [a] = toPagedAgents(control);

        expect({
            configRead: await measureBoundedWaitsMs(() => layoutSwitch.readServedOverlapMs()),
            topologyWrite: await measureBoundedWaitsMs(() => layoutSwitch.writeTopologyKind('tree')),
            health: await measureBoundedWaitsMs(() => layoutSwitch.readHealth(a).catch(() => undefined)),
            stream: await measureBoundedWaitsMs(() =>
                layoutSwitch.runStream({
                    agent: a,
                    qos: { reliability: 'best-effort', ack: 'none' },
                    rateHz: 10,
                    durationMs: LAYOUT_SWITCH_STREAM_DURATION_MS
                })
            )
        }).toEqual(LIVE_RTC_LAYOUT_SWITCH_OPERATION_BOUNDED_WAITS_MS);
    });
});
