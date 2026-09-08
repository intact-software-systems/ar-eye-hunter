import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';
import { evaluateScenarioTransform } from '../../shared-test/black-box-runner/execution/black-box-output-transform.ts';
import { withPollUntil } from '../../shared-test/black-box-runner/execution/with-poll-until.ts';
import {
    createRallarRtcClientEventDispatcher,
    createRallarRtcRuntimeFromDataChannelFactory,
    toRallarRtcClientArgs
} from '../../shared-test/black-box-runner/rallar-rtc-provider.ts';
import { createRallarWebRtcWebSocketSignalingFactory } from '../../shared-test/black-box-runner/rallar-webrtc-runtime.ts';
import {
    waitForRtcMessage,
    waitForRtcMessageAbsence,
    waitForRtcMessageCount
} from '../../shared-test/black-box-runner/rtc/rtc-wait-expectations.ts';
import {
    waitForWsMessage,
    waitForWsMessageAbsence,
    waitForWsMessageCount
} from '../../shared-test/black-box-runner/ws/ws-wait-expectations.ts';

import { createDefaultExecutionDependencies } from '../../shared-test/black-box-runner/execution/black-box-scenario-context.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('black-box execution dependencies', () => {
    it('uses the scenario clock and ID source for transforms', () => {
        const context = { correlation: {}, dependencies: { now: () => 1234, createUuid: () => 'owned-id' } };
        expect(evaluateScenarioTransform({ context, transform: { op: 'timestamp' } })).toBe(1234);
        expect(evaluateScenarioTransform({ context, transform: { op: 'uuid' } })).toBe('owned-id');
    });

    it('uses the execution clock for report timestamps and the ID source for correlation', async () => {
        const report = await executeBlackBox([{ SET: { request: { output: 'value', value: 1 }, response: {} }, setValue: {} }], 0, {
            dependencies: { now: () => 1234, createUuid: () => 'owned-id' }
        });
        expect(report.resultsList[0]).toMatchObject({ startedAtEpochMs: 1234, endedAtEpochMs: 1234 });
        expect(JSON.stringify(report)).toContain('bb-run-owned-id');
    });

    it('uses the supplied clock to measure the polling stability window', async () => {
        let now = 100;
        const result = await withPollUntil({
            request: { poll: { maxAttempts: 2, stableForMs: 10, backoffMs: 0 } },
            now: () => now,
            execute: async () => {
                now += 10;
                return { status: 'SUCCESS' };
            }
        });
        expect(result).toMatchObject({ status: 'SUCCESS', pollAttempts: 2, pollElapsedMs: 20 });
    });
});

for (const transport of ['RTC', 'WS'] as const) {
    it(`${transport} timeout eligibility follows its owned clock`, async () => {
        vi.useFakeTimers();
        let now = 0;
        const context = {
            dependencies: { now: () => now, createUuid: () => 'unused' },
            rtcMessages: {},
            wsMessages: {},
            rtcConnections: {},
            rtcCloseEvents: {}
        };
        const interaction = { request: { connection: 'peer' }, response: { message: 'missing', withinMs: 10 } };
        const input = { context, interaction, config: { interaction } };
        let settled = false;
        const pending = (transport === 'RTC' ? waitForRtcMessage(input) : waitForWsMessage(input))
            .then((result) => {
                settled = true;
                return result;
            });
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(false);
        now = 10;
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toMatchObject({ status: 'FAILURE', actual: { waitedMs: 10 } });
    });
}

for (const transport of ['data-channel', 'signaling'] as const) {
    it(`${transport} native open timeout follows its factory clock`, async () => {
        vi.useFakeTimers();
        let now = 0;
        const channel = { readyState: 'connecting', send() {}, close() {} };
        const input = { now: () => now, waitForOpen: true, openTimeoutMs: 10 };
        const runtime = transport === 'data-channel'
            ? createRallarRtcRuntimeFromDataChannelFactory({ ...input, connect: () => channel })
            : createRallarWebRtcWebSocketSignalingFactory({ ...input, createTransport: () => channel });
        let settled = false;
        const pending = Promise.resolve(runtime.connect(
            toRallarRtcClientArgs({ connection: 'peer' }),
            createRallarRtcClientEventDispatcher()
        )).then(
            () => {
                settled = true;
                return undefined;
            },
            (error: unknown) => {
                settled = true;
                return error;
            }
        );
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(false);
        now = 10;
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toBeInstanceOf(Error);
    });
}

it('captures the selected UUID method with its native receiver', () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    try {
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => first });
        const dependencies = createDefaultExecutionDependencies();
        Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => second });
        expect(dependencies.createUuid()).toBe(first);
    }
    finally {
        if (descriptor) {
            Object.defineProperty(crypto, 'randomUUID', descriptor);
        }
        else {
            Reflect.deleteProperty(crypto, 'randomUUID');
        }
    }
});

for (const transport of ['RTC', 'WS'] as const) {
    for (const expectation of ['count', 'absence'] as const) {
        it(`${transport} ${expectation} window remains pending until its owned deadline`, async () => {
            vi.useFakeTimers();
            let now = 0;
            const context = {
                dependencies: { now: () => now, createUuid: () => 'unused' },
                rtcMessages: {},
                wsMessages: {},
                rtcConnections: {},
                rtcCloseEvents: {}
            };
            const response = expectation === 'count'
                ? { message: 'forbidden', count: 0, withinMs: 10 }
                : { absent: 'forbidden', withinMs: 10 };
            const interaction = { request: { connection: 'peer' }, response };
            const input = { context, interaction, config: { interaction } };
            const wait = transport === 'RTC'
                ? (expectation === 'count' ? waitForRtcMessageCount : waitForRtcMessageAbsence)
                : (expectation === 'count' ? waitForWsMessageCount : waitForWsMessageAbsence);
            let settled = false;
            const pending = wait(input).then((result) => {
                settled = true;
                return result;
            });
            await vi.advanceTimersByTimeAsync(50);
            expect(settled).toBe(false);
            now = 10;
            await vi.advanceTimersByTimeAsync(10);
            expect(await pending).toMatchObject({ status: 'SUCCESS', actual: { waitedMs: 10 } });
        });
    }
}
