import { executeLocalWsInteraction } from '@shared-test/black-box-runner/execution/execute-local-ws-interaction.ts';
import { executeRemoteWsInteraction } from '@shared-test/black-box-runner/execution/remote-browser-websocket-interaction.ts';
import { waitForWsMessage, waitForWsMessageAbsence, waitForWsMessages } from '@shared-test/black-box-runner/ws/ws-wait-expectations.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TestWebSocket } from '../shared/websocket/test-web-socket.ts';

const config = { interactionName: 'wait', interaction: { request: {} } };
const interaction = { request: { connection: 'socket' }, response: { absent: { forbidden: true }, withinMs: 50 } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('fails absence when retained evidence is evicted during the full observation window', async () => {
    const context = { wsMessages: { socket: [{ data: { forbidden: true } }] }, wsObservationLoss: { socket: 0 } };
    const waiting = waitForWsMessageAbsence({ interaction, config, context });
    context.wsMessages.socket = [];
    context.wsObservationLoss.socket++;
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: 'FAILURE', result: expect.stringContaining('discarded') });
});

it('allows a fresh full window after historical loss without resetting a pending older window', async () => {
    const context = { wsMessages: { socket: [] }, wsObservationLoss: { socket: 7 } };
    const oldWindow = waitForWsMessageAbsence({ interaction, config, context });
    context.wsObservationLoss.socket++;
    const freshWindow = waitForWsMessageAbsence({ interaction, config, context });
    await vi.advanceTimersByTimeAsync(49);
    await vi.advanceTimersByTimeAsync(1);
    expect(await oldWindow).toMatchObject({ status: 'FAILURE' });
    expect(await freshWindow).toMatchObject({ status: 'SUCCESS', actual: { waitedMs: 50 } });
});

it('preserves forbidden buffered-message detection even when it predates the absence window', async () => {
    const context = { wsMessages: { socket: [{ data: { forbidden: true } }] } };
    const waiting = waitForWsMessageAbsence({ interaction, config, context });
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: 'FAILURE', actual: { matchedMessage: { data: { forbidden: true } } } });
});

it('does not let a consuming positive wait erase evidence from a concurrent absence wait', async () => {
    const context = { wsMessages: { socket: [{ data: { forbidden: true } }] } };
    const absence = waitForWsMessageAbsence({ interaction, config, context });
    const positive = waitForWsMessage({
        interaction: { request: interaction.request, response: { message: { forbidden: true }, consume: true, withinMs: 50 } },
        config,
        context
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await positive).toMatchObject({ status: 'SUCCESS' });
    expect(await absence).toMatchObject({ status: 'FAILURE' });
});

it('matches ordered messages without mutating the retained observations until consumption is requested', async () => {
    const context = { wsMessages: { socket: [{ data: { n: 2 } }, { data: { n: 1 } }, { data: { n: 2 } }] } };
    const waiting = waitForWsMessages({
        interaction: { request: interaction.request, response: { messages: [{ n: 1 }, { n: 2 }], ordered: true, consume: true } },
        config,
        context
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(await waiting).toMatchObject({
        status: 'SUCCESS',
        actual: {
            ordered: true,
            matchedMessages: [
                { matchedMessage: { data: { n: 1 } } },
                { matchedMessage: { data: { n: 2 } } }
            ]
        }
    });
    expect(context.wsMessages.socket).toEqual([{ data: { n: 2 } }]);
});

it('fails an interrupted absence window when a remotely observed socket close arrives', async () => {
    const closeEvents: unknown[] = [];
    const context = { wsMessages: { socket: [] }, wsCloseEvents: { socket: closeEvents } };
    const waiting = waitForWsMessageAbsence({ interaction, config, context, observeCloseEvents: true });
    context.wsCloseEvents.socket.push({ code: 1000 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: 'FAILURE' });
});

it('does not treat a saturated observation-loss counter as complete evidence', async () => {
    const context = { wsMessages: { socket: [] }, wsObservationLoss: { socket: Number.MAX_SAFE_INTEGER } };
    const waiting = waitForWsMessageAbsence({ interaction, config, context });
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: 'FAILURE' });
});

it('fails remote absence when polling loses access to the event stream during its window', async () => {
    let reads = 0;
    const context = {
        wsConnections: { socket: new TestWebSocket('ws://remote.example.test') },
        wsMessages: { socket: [] },
        wsCloseEvents: {},
        options: {
            rallarRemoteBrowser: {
                controlBaseUrl: 'http://control.example.test',
                runId: 'run',
                agentId: 'agent',
                pollIntervalMs: 5,
                fetch: async () => {
                    if (reads++ > 0) {
                        throw new Error('control server unavailable');
                    }
                    return Response.json({ runId: 'run', events: [] });
                }
            }
        }
    };
    const waiting = executeRemoteWsInteraction(
        {
            request: { action: 'wait', connection: 'socket' },
            response: interaction.response
        },
        config,
        context
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(await waiting).toMatchObject({ status: 'FAILURE', result: expect.stringContaining('discarded') });
});

it('preserves explicit null payloads when sending through the local socket owner', async () => {
    const socket = new TestWebSocket('ws://local.example.test');
    socket.open();
    const context = { wsConnections: { socket }, wsMessages: {}, wsCloseEvents: {} };
    await executeLocalWsInteraction({ request: { action: 'send', connection: 'socket', send: null } }, config, context);
    expect(socket.sent).toEqual(['null']);
});

it('keeps stale local close diagnostics from invalidating a healthy new generation window', async () => {
    const closeEvents: unknown[] = [];
    const context = { wsMessages: { socket: [] }, wsCloseEvents: { socket: closeEvents }, wsObservationLoss: { socket: 3 } };
    const waiting = waitForWsMessageAbsence({ interaction, config, context });
    closeEvents.push({ code: 1000 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await waiting).toMatchObject({ status: 'SUCCESS' });
});
