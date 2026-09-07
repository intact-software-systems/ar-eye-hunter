import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createRallarRemoteBrowserRtcProvider,
    executeRallarRemoteBrowserCommand,
    syncRallarRemoteBrowserEvents
} from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

const remote = {
    controlBaseUrl: 'http://control.invalid',
    runId: 'this-run',
    agentId: 'this-agent',
    timeoutMs: 100,
    pollIntervalMs: 1
};
const result = {
    protocolVersion: 1,
    kind: 'result',
    runId: remote.runId,
    agentId: remote.agentId,
    commandId: 'same-command',
    ok: true
};
const event = {
    protocolVersion: 1,
    kind: 'event',
    runId: remote.runId,
    agentId: remote.agentId,
    atEpochMs: 1,
    eventId: 'outer-event',
    payload: {
        eventId: 'message-event',
        kind: 'message',
        topic: 'message',
        atEpochMs: 1,
        transport: 'ws',
        connection: 'socket',
        payload: { data: { arbitrary: ['payload', 1] } }
    }
};

async function executeSnapshot(snapshot: unknown) {
    return await executeRallarRemoteBrowserCommand({
        remote,
        command: { kind: 'health', commandId: result.commandId },
        context: { dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() } },
        fetchFn: async (_input, init) =>
            init?.method === 'POST'
                ? Response.json({ accepted: true }, { status: 202 })
                : Response.json(snapshot)
    });
}

describe('remote-browser command results', () => {
    it('reports malformed result truthiness as a connection failure at the public provider', async () => {
        const interaction = { request: { commandId: result.commandId, connection: 'socket' }, response: {} };
        const context = { dependencies: { now: Date.now, createUuid: () => crypto.randomUUID() }, rtcConnections: {}, rtcMessages: {}, rtcCloseEvents: {} };
        const provider = createRallarRemoteBrowserRtcProvider({
            ...remote,
            fetch: async (_input, init) =>
                init?.method === 'POST'
                    ? Response.json({ accepted: true }, { status: 202 })
                    : Response.json({ runId: remote.runId, results: [{ ...result, ok: 'false' }], events: [] })
        });
        const outcome = await provider.connect(interaction, { interaction }, context);
        expect(outcome.status).toBe('FAILURE');
        expect(context.rtcConnections).toEqual({});
    });

    it('matches the run and agent as well as the command identity', async () => {
        const received = await executeSnapshot({
            runId: remote.runId,
            results: [
                { ...result, agentId: 'another-agent', ok: false },
                { ...result, commandId: 'another-command', ok: false },
                result
            ],
            events: []
        });
        expect(received).toMatchObject(result);
    });

    it.each([
        { ...result, ok: 'false' },
        { ...result, protocolVersion: undefined },
        { ...result, kind: 'event' },
        { ...result, runId: '' },
        { ...result, agentId: {} },
        { ...result, commandId: '' },
        { ...result, runId: 'another-run' }
    ])('rejects malformed command envelopes instead of accepting their truthiness: %j', async (invalid) => {
        await expect(executeSnapshot({ runId: remote.runId, results: [invalid], events: [] }))
            .rejects.toThrow(/Invalid remote browser snapshot/);
    });

    it.each([
        null,
        [],
        { runId: 'another-run', results: [result], events: [] },
        { runId: remote.runId, results: {}, events: [] },
        { runId: remote.runId, results: [result], events: {} }
    ])('rejects malformed HTTP observation containers: %j', async (snapshot) => {
        await expect(executeSnapshot(snapshot)).rejects.toThrow(/Invalid remote browser snapshot/);
    });

    it.each([
        { ...event, protocolVersion: undefined },
        { ...event, agentId: [] },
        { ...event, payload: { ...event.payload, connection: {} } },
        { ...event, payload: { ...event.payload, kind: 'invented' } },
        { ...event, payload: { ...event.payload, topic: 2 } },
        { ...event, payload: { ...event.payload, atEpochMs: '1' } },
        { ...event, payload: { ...event.payload, transport: [] } }
    ])('rejects invalid event projections before storing any snapshot observations: %j', async (invalid) => {
        const context = {};
        await expect(syncRallarRemoteBrowserEvents(remote, async () =>
            Response.json({
                runId: remote.runId,
                results: [],
                events: [event, invalid]
            }), context)).rejects.toThrow(/Invalid remote browser snapshot/);
        expect(context).toEqual({});
    });

    it('preserves arbitrary message data from a valid event', async () => {
        const context = {};
        await syncRallarRemoteBrowserEvents(remote, async () =>
            Response.json({
                runId: remote.runId,
                results: [],
                events: [event]
            }), context);
        expect(context).toMatchObject({ wsMessages: { socket: [{ data: { arbitrary: ['payload', 1] } }] } });
    });
});
