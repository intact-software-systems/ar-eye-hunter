import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { toConformanceInput } from './alm-conformance-test-input.ts';
import { writeAlmCellStartEvents } from './write-alm-cell-start-events.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([
    { arrivals: [0, 2, 3, 4], passes: true, reason: 'uncongested delivery' },
    { arrivals: [0, 3, 4], passes: true, reason: 'carrier conflates the first selected intermediate value' },
    { arrivals: [4], passes: true, reason: 'carrier retains only the latest value' },
    { arrivals: [0, 2, 3], passes: false, reason: 'latest value never arrives' },
    { arrivals: [0, 1, 4], passes: false, reason: 'displaced value reaches the receiver' }
])('checks newest-N receiver evidence: $reason', async ({ arrivals, passes }) => {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc'))
        .find((candidate) => candidate.scenarioId === 'paced-newest-n');
    if (scenario === undefined) {
        throw new Error('Missing newest-N scenario.');
    }
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime();
    writeAlmCellStartEvents(runtime, scenario.receiver.commands);
    for (const seq of arrivals) {
        setTimeout(() =>
            runtime.receiveRallarBrowserEvent({
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                connection: 'receiver',
                data: {
                    msgId: `message-${seq}`,
                    traceId: `trace-${seq}`,
                    corrId: `message-${seq}`,
                    typeId: 'alm.conformance.rtc.paced-newest-n',
                    topicId: 'room.alm-conformance',
                    transport: 'rtc',
                    payload: { specimen: 'paced', seq }
                }
            }), seq === 0 ? 100 : seq === 4 ? 4_100 : 2_100);
    }
    // Execute the authored receiver evidence, excluding only external connection setup and final stats.
    const commands = scenario.receiver.commands.filter((command) => command.kind === 'wait' || command.kind === 'messages.received');
    const result = runtime.execute({ kind: 'recipe.run', recipe: { ...scenario.receiver, commands } });
    await vi.runAllTimersAsync();
    expect((await result).ok, JSON.stringify(runtime.state().failures)).toBe(passes);
});

it.each([
    { selected: 2, deferred: 1, expired: 0, attempts: 0, passes: true },
    { selected: 3, deferred: 0, expired: 0, attempts: 0, passes: false },
    { selected: 1, deferred: 2, expired: 0, attempts: 0, passes: false },
    { selected: 2, deferred: 0, expired: 1, attempts: 0, passes: false },
    { selected: 2, deferred: 1, expired: 0, attempts: 1, passes: false }
])('checks newest-N stage evidence: %j', async ({ selected, deferred, expired, attempts, passes }) => {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc'))
        .find((candidate) => candidate.scenarioId === 'paced-newest-n');
    if (scenario === undefined) {
        throw new Error('Missing newest-N scenario.');
    }
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: async (command) =>
            command.kind === 'messages.observe'
                ? { status: 'ok', value: { state: command.state?.[0], attempts, reason: 'The publication stage displaced it before its opportunity.' } }
                : undefined
    });
    writeAlmCellStartEvents(runtime, scenario.sender.commands);
    runtime.recordEvent({
        kind: 'diagnostic',
        topic: 'rallar.browser.alm.outbound_diagnostics',
        payload: { data: { kind: 'publication-opportunity', laneKey: 'room.alm-conformance/alm.conformance.rtc.paced-newest-n', selected, deferred, expired } }
    });
    const burstIndex = scenario.sender.commands.findIndex((command) => command.kind === 'loop');
    const commands = scenario.sender.commands.slice(burstIndex + 1);
    const result = runtime.execute({ kind: 'recipe.run', recipe: { ...scenario.sender, commands } });
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(passes);
});
