import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';
import { LIVE_RTC_AGENT_REOPEN_BOUNDED_WAITS_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-agent-opening-waits.ts';
import { LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/live-rtc-control-waits.ts';
import { FULL_STACK_EXPECT_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/playwright-expect-timeouts.ts';
import type { RtcBaselineJson } from '../../shared-rtc-bench/baseline/contracts/rtc-baseline-contracts.ts';

import {
    LIFECYCLE_CONNECT_RETRY_INTERVAL_MS,
    LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS,
    LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS
} from '../../../tests/playwright/rallar-black-box/compute-live-rtc-lifecycle-scenario-timeout-ms.ts';
import type { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import { createLiveRtcDeliveryOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-delivery-operations.ts';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';
import { LiveRtcLifecycleOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-lifecycle-operations.ts';
import {
    createCountedPage,
    measureBoundedWaitsMs,
    settleUnderFakeTimers,
    spendBoundedWait,
    useBoundedWaitClock,
    type PlaywrightArgument
} from './bounded-wait-clock-fixture.ts';
import { RecordingLiveRtcControl } from './recording-live-rtc-control-fixture.ts';

vi.mock('@playwright/test', async (importOriginal) => {
    const { toCountedPlaywrightModule } = await import('./bounded-wait-clock-fixture.ts');
    return toCountedPlaywrightModule(await importOriginal(), FULL_STACK_EXPECT_TIMEOUT_MS);
});

const formation = createLiveRtcFormationOperations();
const lifecycle = new LiveRtcLifecycleOperations({
    formation,
    delivery: createLiveRtcDeliveryOperations({
        almDiagnostics: true,
        apiBaseUrl: 'http://localhost:18080',
        applicationId: 'app',
        workspaceId: 'work',
        messagesRtcTypeId: 'type',
        messagesRtcTopicId: 'topic',
        formation
    }),
    apiBaseUrl: 'http://localhost:18080',
    applicationId: 'app',
    workspaceId: 'work'
});

const BROWSER_CONFIG = {
    spaBaseUrl: 'http://localhost:5176',
    controlWsUrl: 'ws://localhost:18081',
    apiBaseUrl: 'http://localhost:18080',
    register: false
};

/** A dormant member holding no lane: what every health of the counted group reads. */
const DORMANT_HEALTH: RtcBaselineJson = {
    rallar: {
        formation: { stage: 'dormant', dialing: 'none' },
        rtcStatus: { knownPeerIds: [], activePeerIds: [], readyPeerIds: [] }
    }
};

useBoundedWaitClock();

/** The fake clock's resolution: the connect's last attempt starts this long before its deadline at the latest. */
const CLOCK_TICK_MS = 1;

/**
 * How long the first of two refused connects is held, beyond its own command wait and the retry interval, so that the
 * second starts one tick before the connect's deadline.
 */
const LATE_SECOND_CONNECT_HOLD_MS = LIFECYCLE_CONNECT_WHEN_PLANNED_TIMEOUT_MS - CLOCK_TICK_MS -
    (LIVE_RTC_UNBUDGETED_COMMAND_WAIT_MS + LIFECYCLE_CONNECT_RETRY_INTERVAL_MS);

/**
 * The session a counted page holds, or nothing for an evaluation that names a bound: a room refresh, which the page
 * spends as the browser would.
 */
async function evaluateCountedPage(argument: PlaywrightArgument) {
    if (typeof argument === 'object' && argument !== null && 'timeoutMs' in argument && typeof argument.timeoutMs === 'number') {
        await spendBoundedWait(argument.timeoutMs);
        return undefined;
    }
    return JSON.stringify({ clientId: 'client', accessToken: 'token', username: 'user', sessionId: 'restored', expiresAtEpochMs: 1 });
}

/** A browser whose every page is a counted page holding the restored session. */
const COUNTED_BROWSER = {
    newContext: async () => ({ newPage: async () => createCountedPage(evaluateCountedPage), close: async () => {} })
};

/** Each agent's single recorded dial, as the counted group's run reads it. */
function toDialedRun(agents: readonly LiveRtcControlClient.Agent[]): LiveRtcControlClient.RunSnapshot {
    return {
        agents: [],
        results: [],
        events: agents.map((agent) => ({
            agentId: agent.agentId,
            payload: { topic: 'rallar.browser.rtc.lifecycle', atEpochMs: 0, payload: { data: { kind: 'peer-created' } } }
        }))
    };
}

/**
 * The recording control as a managed group answers the lifecycle: every connect restores the session it expects,
 * every formation command reports the active stage, every health reads `health`, and each run read is one control
 * request. The owner's first layout connects, one per entry of `refusedConnectHoldsMs`, are refused for naming no
 * planned layout, each after its command wait and then its hold.
 */
function createLifecycleRun(
    health: RtcBaselineJson = DORMANT_HEALTH,
    refusedConnectHoldsMs: readonly number[] = []
): LiveRtcLifecycleOperations.Run {
    const recording = new RecordingLiveRtcControl({ lifecycleState: 'active', acceptedSessions: [] }, spendBoundedWait);
    const recordCommand = recording.executeOk;
    let refusals = 0;
    const executeOk = async (input: LiveRtcControlClient.ExecuteInput): Promise<LiveRtcControlClient.Result> => {
        const recorded = await recordCommand(input);
        const { command } = input;
        const refusalHoldMs = refusedConnectHoldsMs[refusals];
        if (command.kind === 'formation.command' && command.command === 'connect' && refusalHoldMs !== undefined) {
            refusals += 1;
            await spendBoundedWait(refusalHoldMs);
            return { ...recorded, ok: false, error: { message: 'no planned layout' } };
        }
        if (command.kind === 'rtc.connect') {
            const sessionId = command.rallar?.expectedSessionId;
            return { ...recorded, result: { value: { sessionId: typeof sessionId === 'string' ? sessionId : '' } } };
        }
        if (command.kind === 'formation.command') {
            return { ...recorded, result: { value: { formation: { stage: 'active' } } } };
        }
        return command.kind === 'health' ? { ...recorded, result: { value: health } } : recorded;
    };
    const agents = recording.agents.map((agent) => ({
        ...agent,
        page: createCountedPage(evaluateCountedPage),
        context: { close: async () => {} },
        refreshRoom: async (options: { readonly timeoutMs: number; }) => await spendBoundedWait(options.timeoutMs)
    }));
    const control = Object.assign(recording, {
        executeOk,
        executeResult: executeOk,
        fetchRun: async () => {
            await spendBoundedWait(CONTROL_REQUEST_TIMEOUT_MS);
            return toDialedRun(agents);
        }
    });
    return { control, runId: 'run', groupId: 'room', suffix: 'counted', agents: [agents[0], agents[1], agents[2]] };
}

describe('the live RTC lifecycle building blocks wait what their derivation counts', () => {
    it('connects a member\'s presence within the presence connect\'s wait', async () => {
        const run = createLifecycleRun();

        expect(await measureBoundedWaitsMs(() => lifecycle.connectPresence(run, run.agents[0]))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.presenceConnect
        );
    });

    it('sets up the trio\'s membership and presence within their bounded waits', async () => {
        const run = createLifecycleRun();

        expect(await measureBoundedWaitsMs(() => lifecycle.connectTrioPresence(run))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.trioPresence
        );
    });

    // The connect was checked only against an upper bound, which a derivation without its retry interval also met.
    it('retries a connect that finds no planned layout for its whole bound when its last attempt starts at the deadline', async () => {
        const run = createLifecycleRun(DORMANT_HEALTH, [LATE_SECOND_CONNECT_HOLD_MS, 0]);

        expect(await measureBoundedWaitsMs(() => lifecycle.connectWhenPlanned(run).catch(() => undefined))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.connectWhenPlanned - CLOCK_TICK_MS
        );
    });

    // A connect accepted at the deadline ends the loop without its retry interval, the one term no activation reaches.
    it('activates the group within the activation\'s bounded waits', async () => {
        const run = createLifecycleRun(DORMANT_HEALTH, [LATE_SECOND_CONNECT_HOLD_MS]);

        expect(await measureBoundedWaitsMs(() => lifecycle.activateGroup(run))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.activation - LIFECYCLE_CONNECT_RETRY_INTERVAL_MS - CLOCK_TICK_MS
        );
    });

    it('reopens a member and connects its presence within the reopened presence\'s bounded waits', async () => {
        const run = createLifecycleRun();

        expect(
            await measureBoundedWaitsMs(async () => {
                const reopenedRun = await lifecycle.reopen(run, { browser: COUNTED_BROWSER, config: BROWSER_CONFIG, index: 2 });
                await lifecycle.connectPresence(reopenedRun, reopenedRun.agents[2]);
            })
        ).toBe(LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.reopenedPresence);
    });

    // Reopening replaced the member in the caller's own run.
    it('reopens a member into a new run, leaving the caller\'s run as it was', async () => {
        const run = createLifecycleRun();
        const before = [...run.agents];

        const reopenedRun = await settleUnderFakeTimers(() => lifecycle.reopen(run, { browser: COUNTED_BROWSER, config: BROWSER_CONFIG, index: 2 }));

        expect(run.agents).toEqual(before);
        expect([reopenedRun.agents[0], reopenedRun.agents[1], reopenedRun.agents[2] === before[2]]).toEqual([before[0], before[1], false]);
    });

    it('reopens a member, connects its presence and settles the survivors within the reopening\'s bounded waits', async () => {
        const run = createLifecycleRun();

        expect(
            await measureBoundedWaitsMs(async () => {
                const reopenedRun = await lifecycle.reopen(run, { browser: COUNTED_BROWSER, config: BROWSER_CONFIG, index: 1 });
                await lifecycle.connectPresence(reopenedRun, reopenedRun.agents[1]);
                await lifecycle.settleSurvivors(reopenedRun, reopenedRun.agents[1]);
            })
        ).toBe(LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.reopening);
        expect(LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.reopenedPresence).toBe(
            LIVE_RTC_AGENT_REOPEN_BOUNDED_WAITS_MS + LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.presenceConnect
        );
    });

    it('reads a member\'s recorded formation changes within the changes read\'s bounded waits', async () => {
        const run = createLifecycleRun();

        expect(await measureBoundedWaitsMs(() => lifecycle.readFormationChanges(run, run.agents[1], 0))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.formationChanges
        );
        expect(LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.formationChanges).toBe(CONTROL_REQUEST_TIMEOUT_MS);
    });

    it('reads a reopened member that never takes the room on every attempt within the room-held bounded waits', async () => {
        const run = createLifecycleRun({});

        expect(await measureBoundedWaitsMs(() => lifecycle.expectRoomHeld(run, run.agents[1]).catch(() => undefined))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.roomHeld
        );
    });

    it('resets the trio to dormant within the trio reset\'s bounded waits', async () => {
        const run = createLifecycleRun();

        expect(await measureBoundedWaitsMs(() => lifecycle.resetTrioToDormant(run))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.trioReset
        );
    });

    // As for activation, a connect accepted at the deadline waits all but the retry interval.
    it('starts and plans the next series and dials again within the redial\'s bounded waits', async () => {
        const run = createLifecycleRun(DORMANT_HEALTH, [LATE_SECOND_CONNECT_HOLD_MS]);

        expect(await measureBoundedWaitsMs(() => lifecycle.redial(run, [0, 0, 0]))).toBe(
            LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.redial - LIFECYCLE_CONNECT_RETRY_INTERVAL_MS - CLOCK_TICK_MS
        );
    });

    it('resets the owner to dormant, then reads a reopened member\'s hydrated healths within their bounded waits', async () => {
        const run = createLifecycleRun();

        expect({
            ownerReset: await measureBoundedWaitsMs(() => lifecycle.resetOwnerToDormant(run)),
            hydratedHealths: await measureBoundedWaitsMs(() => lifecycle.readHydratedHealths(run, run.agents[2]))
        }).toEqual({
            ownerReset: LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.ownerReset,
            hydratedHealths: LIVE_RTC_LIFECYCLE_OPERATION_BOUNDED_WAITS_MS.hydratedHealths
        });
    });
});
