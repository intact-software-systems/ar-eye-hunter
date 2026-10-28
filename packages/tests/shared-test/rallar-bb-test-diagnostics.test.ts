import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createDefaultRallarBlackBoxBrowserTestRuntime,
    createDefaultRallarBlackBoxTestRuntime,
    toRallarBlackBoxDiagnostics,
    toRallarBlackBoxRuntimeDiagnostic
} from '../../shared-test/rallar-bb-test/mod.ts';
import { isJsonRecordValue } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

describe('rallar-bb-test runtime diagnostics', () => {
    it.each([undefined, 'enabled'] as const)('keeps the complete browser sequence with recording %s', async (selection) => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ routineBrowserDiagnostics: selection });
        runtime.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'routine-progress',
            routineBrowserDiagnostic: true,
            data: { password: 'secret', step: 1 }
        });
        runtime.receiveRallarBrowserEvent({ kind: 'message', topic: 'delivered', data: { token: 'secret', text: 'hello' } });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'observer', data: { status: 'ready' } });
        runtime.receiveRallarBrowserEvent({ kind: 'close', topic: 'closed' });

        expect(runtime.state().events.map((event) => event.topic)).toEqual(['routine-progress', 'delivered', 'observer', 'closed']);
        expect(runtime.state().events[0].payload).toHaveProperty('data', { password: '<redacted>', step: 1 });
        expect(runtime.state().events[1].payload).toHaveProperty('data', { token: '<redacted>', text: 'hello' });
        const health = await runtime.execute({ kind: 'health' });
        expect(health.value).toHaveProperty('browserDiagnostics', {
            routineBrowserDiagnostics: 'enabled',
            omittedRoutineBrowserDiagnostics: 0,
            forwardedBrowserDiagnostics: 2
        });
    });

    it('omits only certified routine info while retaining failures, ambiguity and functional events', async () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ routineBrowserDiagnostics: 'disabled' });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'routine-progress', routineBrowserDiagnostic: true });
        const retained = [
            { kind: 'message', topic: 'message', routineBrowserDiagnostic: true },
            { kind: 'close', topic: 'close', routineBrowserDiagnostic: true },
            { kind: 'diagnostic', topic: 'warning', severity: 'warning', routineBrowserDiagnostic: true },
            { kind: 'diagnostic', topic: 'error', severity: 'error', routineBrowserDiagnostic: true },
            { kind: 'diagnostic', topic: 'debug', severity: 'debug', routineBrowserDiagnostic: true },
            {
                kind: 'diagnostic',
                topic: 'explicit-info-cause',
                severity: 'info',
                routineBrowserDiagnostic: true,
                error: { name: 'Error', message: 'failed', stack: undefined }
            },
            { kind: 'diagnostic', topic: 'explicit-info-status', severity: 'info', routineBrowserDiagnostic: true, data: { status: 'failed' } },
            { kind: 'diagnostic', topic: 'explicit-info-unavailable', severity: 'info', routineBrowserDiagnostic: true, data: { status: 'no-peers' } },
            { kind: 'diagnostic', topic: 'ordinary-progress', data: { status: 'ready' } },
            { kind: 'diagnostic', topic: 'nested-info', data: { snapshot: { status: 'failed' } } },
            { kind: 'diagnostic', topic: 'marked-nested-info', severity: 'info', routineBrowserDiagnostic: true, data: { snapshot: { status: 'failed' } } },
            { kind: 'diagnostic', topic: 'marked-null-info', severity: 'info', routineBrowserDiagnostic: true, data: null },
            { topic: 'ambiguous-kind', routineBrowserDiagnostic: true },
            { kind: 'diagnostic', topic: 'rallar.browser.connect_completed', data: { status: 'connected' } },
            { kind: 'diagnostic', topic: 'rallar.browser.connect.phase_completed', data: { phase: 'rallar-connect', almDiagnostics: false } }
        ] as const;
        for (const event of retained) {
            runtime.receiveRallarBrowserEvent(event);
        }
        runtime.recordEvent({ kind: 'diagnostic', topic: 'core-control', severity: 'info' });

        expect(runtime.state().events.map((event) => event.topic)).toEqual([
            'message',
            'close',
            'warning',
            'error',
            'debug',
            'explicit-info-cause',
            'explicit-info-status',
            'explicit-info-unavailable',
            'ordinary-progress',
            'nested-info',
            'marked-nested-info',
            'marked-null-info',
            'ambiguous-kind',
            'rallar.browser.connect_completed',
            'rallar.browser.connect.phase_completed',
            'core-control'
        ]);
        await runtime.execute({ kind: 'configure', config: { browser: { routineBrowserDiagnostics: 'enabled' } } });
        const health = await runtime.execute({ kind: 'health', commandId: 'applied-policy' });
        expect(health.ok).toBe(true);
        expect(health.value).toMatchObject({
            browserDiagnostics: { routineBrowserDiagnostics: 'disabled', omittedRoutineBrowserDiagnostics: 1, forwardedBrowserDiagnostics: 13 },
            stats: { rallar: { connected: true }, counters: { diagnostics: 15, messages: 1 } }
        });
        expect(runtime.state().events.some((event) => event.topic === 'rallar.bb.command.result' && event.commandId === 'applied-policy')).toBe(true);
        expect(runtime.state().resultCache['applied-policy'].value).toHaveProperty('browserDiagnostics.omittedRoutineBrowserDiagnostics', 1);
    });

    it('keeps admission counts for the adapter lifetime through reset and close', async () => {
        const options = { routineBrowserDiagnostics: 'disabled' as const };
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime(options);
        const initial = await runtime.execute({ kind: 'health' });
        expect(initial.value).toHaveProperty('browserDiagnostics', {
            routineBrowserDiagnostics: 'disabled',
            omittedRoutineBrowserDiagnostics: 0,
            forwardedBrowserDiagnostics: 0
        });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'routine-progress', routineBrowserDiagnostic: true });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'retained-progress' });
        runtime.receiveRallarBrowserEvent({ kind: 'message', topic: 'message' });
        await runtime.execute({ kind: 'reset' });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'routine-progress', routineBrowserDiagnostic: true });
        runtime.receiveRallarBrowserEvent({ kind: 'diagnostic', topic: 'retained-progress' });
        await runtime.execute({ kind: 'close' });
        const health = await runtime.execute({ kind: 'health' });

        expect(health.value).toHaveProperty('browserDiagnostics', {
            routineBrowserDiagnostics: 'disabled',
            omittedRoutineBrowserDiagnostics: 2,
            forwardedBrowserDiagnostics: 2
        });
        expect(runtime.state().latestStats?.counters.diagnostics).toBe(1);
        const fresh = createDefaultRallarBlackBoxBrowserTestRuntime(options);
        const freshHealth = await fresh.execute({ kind: 'health' });
        expect(freshHealth.value).toHaveProperty('browserDiagnostics', {
            routineBrowserDiagnostics: 'disabled',
            omittedRoutineBrowserDiagnostics: 0,
            forwardedBrowserDiagnostics: 0
        });
    });

    it('keeps a payload record subject fact only when it decodes, and resolves the type and topic ids once', () => {
        const unreadable = toRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.browser.rtc.lane_state',
            severity: 'warning',
            source: 'unit-test',
            payload: {
                transport: 'carrier-pigeon',
                commandId: 7,
                connection: ' ',
                actor: { name: 'alice' },
                atEpochMs: 'late',
                typeId: 42,
                topicId: false,
                lane: 'rtc-realtime'
            }
        });
        const readable = toRallarBlackBoxRuntimeDiagnostic({
            topic: 'rallar.browser.rtc.lane_state',
            severity: 'warning',
            source: 'unit-test',
            payload: {
                transport: 'messages.rtc',
                commandId: 'rtc-connect-1',
                connection: 'aliceRtc',
                actor: 'alice',
                atEpochMs: 1_000
            },
            detail: { typeId: 'room.state', topicId: 'room.topic' }
        });

        expect(unreadable).toMatchObject({ lane: 'rtc-realtime' });
        for (const key of ['transport', 'commandId', 'connection', 'actor', 'atEpochMs', 'typeId', 'topicId']) {
            expect(unreadable).not.toHaveProperty(key);
        }
        expect(readable).toMatchObject({
            transport: 'messages.rtc',
            commandId: 'rtc-connect-1',
            connection: 'aliceRtc',
            actor: 'alice',
            atEpochMs: 1_000,
            typeId: 'room.state',
            topicId: 'room.topic'
        });
    });

    it('normalizes transport diagnostics so wait and assert can match them', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        runtime.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            severity: 'warning',
            payload: toRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.browser.ws.unhandled_message',
                transport: 'ws',
                severity: 'warning',
                detail: { pattern: 'unhandled-ws-message', source: 'console.warn' },
                source: 'unit-test'
            })
        });

        const waitResult = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-ws-warning',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.unhandled_message',
                transport: 'ws',
                severity: 'warning',
                payloadPath: 'diagnosticTypeId',
                equals: 'rallar.browser.ws.unhandled_message'
            }
        });
        const assertResult = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-ws-warning',
            source: 'recentDiagnostics.0.payload.data.pattern',
            operator: 'equals',
            expected: 'unhandled-ws-message'
        });

        expect(waitResult.ok).toBe(true);
        expect(waitResult.value).toMatchObject({
            event: {
                payload: {
                    diagnosticSchemaVersion: 1,
                    diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
                    topic: 'rallar.browser.ws.unhandled_message',
                    transport: 'ws',
                    severity: 'warning',
                    message: 'rallar.browser.ws.unhandled_message',
                    data: { pattern: 'unhandled-ws-message', source: 'console.warn' }
                }
            }
        });
        expect(assertResult.ok).toBe(true);
    });

    it('names the producer of a simulated runtime command diagnostic', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();

        await runtime.execute({
            kind: 'rtc.send',
            commandId: 'simulated-send',
            send: { data: { text: 'hello' } }
        });

        const diagnostic = toRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.fake.rtc.send');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticTypeId: 'rallar.bb.fake.rtc.send',
            source: 'simulated-runtime'
        });
    });

    it('normalizes browser Rallar RTC warning events from the adapter bridge', () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime();

        runtime.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.data_channel_label_mismatch',
            connection: 'aliceRtc',
            transport: 'realtime',
            peerId: 'alice-session',
            remotePeerId: 'bob-session',
            data: {
                expectedDataChannelName: 'rtc-realtime',
                actualDataChannelName: 'rtc-data-channel'
            }
        });

        const diagnostic = toRallarBlackBoxDiagnostics(runtime.state())[0];
        expect(diagnostic).toMatchObject({
            topic: 'rallar.browser.rtc.data_channel_label_mismatch',
            connection: 'aliceRtc',
            transport: 'realtime',
            severity: 'warning'
        });
        expect(diagnostic.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_label_mismatch',
            peerId: 'alice-session',
            remotePeerId: 'bob-session',
            data: {
                expectedDataChannelName: 'rtc-realtime',
                actualDataChannelName: 'rtc-data-channel'
            }
        });
    });

    it('records browser event evidence in the JSON form the control connection carries, all the way down', () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime();
        const cyclic: { self?: object; } = {};
        cyclic.self = cyclic;

        runtime.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.lane_state',
            connection: 'aliceRtc',
            data: {
                lane: {
                    changedAt: new Date(0),
                    unset: undefined,
                    retry: () => 'not evidence',
                    peers: ['bob-session', undefined]
                }
            }
        });
        runtime.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.lane_cycle',
            connection: 'aliceRtc',
            data: cyclic
        });

        const [recorded, unrepresentable] = toRallarBlackBoxDiagnostics(runtime.state());
        expect(recorded?.payload).toHaveProperty('data', {
            lane: {
                changedAt: '1970-01-01T00:00:00.000Z',
                peers: ['bob-session', null]
            }
        });
        expect(unrepresentable?.payload).not.toHaveProperty('data.self');
    });

    it('normalizes browser-adapter RTC send failures as structured diagnostics', async () => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => undefined,
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: async () => ({ connected: true }),
                send: async () => ({
                    status: 'no-peers',
                    transport: 'realtime',
                    peerIds: ['bob-session'],
                    results: [],
                    health: []
                }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-without-peer',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                data: {
                    text: 'hello'
                }
            }
        });
        const diagnostic = toRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.rtc.send_failed');

        expect(result.status).toBe('failed');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.bb.rtc.send_failed',
            commandId: 'send-without-peer',
            connection: 'aliceRtc',
            transport: 'realtime',
            severity: 'error',
            message: 'RTC send resolved no target peers.',
            data: {
                status: 'no-peers',
                peerIds: ['bob-session']
            },
            error: {
                code: 'RALLAR_BB_RTC_NO_PEERS'
            }
        });
    });

    it('emits composite result events with child counts while the command result keeps the nested tree', async () => {
        const runtime = createDefaultRallarBlackBoxTestRuntime();
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'nested-run',
            recipe: {
                schemaVersion: 1,
                recipeId: 'nested-composites',
                commands: [{
                    kind: 'loop',
                    commandId: 'repeat',
                    count: 2,
                    commands: [{
                        kind: 'parallel',
                        commandId: 'fan-out',
                        groups: [
                            { groupId: 'left', commands: [{ kind: 'health' }] },
                            { groupId: 'right', commands: [{ kind: 'health' }, { kind: 'health' }] }
                        ]
                    }]
                }]
            }
        });
        const compositeEventValues = runtime.state().events
            .filter((event) => event.topic === 'rallar.bb.command.result')
            .map((event) => isJsonRecordValue(event.payload) ? { kind: event.payload.kind, value: event.payload.value } : {})
            .filter((payload) => payload.kind === 'recipe.run' || payload.kind === 'loop' || payload.kind === 'parallel');

        expect(compositeEventValues).toEqual([
            {
                kind: 'parallel',
                value: expect.objectContaining({
                    childResultCount: 3,
                    passed: 3,
                    failed: 0,
                    groups: [
                        expect.objectContaining({ groupId: 'left', commandCount: 1, passed: 1, failed: 0 }),
                        expect.objectContaining({ groupId: 'right', commandCount: 2, passed: 2, failed: 0 })
                    ]
                })
            },
            { kind: 'parallel', value: expect.objectContaining({ childResultCount: 3, passed: 3, failed: 0 }) },
            { kind: 'loop', value: expect.objectContaining({ childResultCount: 2, passed: 2, failed: 0 }) },
            { kind: 'recipe.run', value: expect.objectContaining({ childResultCount: 1, passed: 1, failed: 0 }) }
        ]);
        expect(JSON.stringify(compositeEventValues)).not.toContain('"results"');
        const compositeEvents = runtime.state().events.filter((event) =>
            event.topic === 'rallar.bb.command.result' && isJsonRecordValue(event.payload) &&
            ['recipe.run', 'loop', 'parallel'].includes(String(event.payload.kind))
        );
        expect(compositeEvents.every((event) => isJsonRecordValue(event.payload) && event.payload.capture === undefined)).toBe(true);
        expect(runtime.state().commandHistory.every((result) => result.capture !== undefined)).toBe(true);
        const nestedParallel = {
            kind: 'parallel',
            value: {
                groups: [
                    { results: [{ result: { kind: 'health', ok: true } }] },
                    { results: [{ result: { kind: 'health', ok: true } }, { result: { kind: 'health', ok: true } }] }
                ]
            }
        };
        expect(result.value).toMatchObject({
            results: [{ kind: 'loop', value: { results: [{ result: nestedParallel }, { result: nestedParallel }] } }]
        });
        expect(runtime.state().resultCache['nested-run']).toEqual(result);
    });
});
