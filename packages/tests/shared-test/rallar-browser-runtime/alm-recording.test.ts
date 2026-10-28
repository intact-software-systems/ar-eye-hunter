import {
    afterEach,
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    BlackBoxRallarRuntimeDiagnostics,
    createBlackBoxRallarDiagnosticsPorts
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import { blackBoxRallarScopeDiagnosticsOf } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-policy.ts';
import {
    resolveBlackBoxRallarLaneId,
    resolveBlackBoxRallarTransport
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-policy.ts';
import { decodeBlackBoxRallarConnectionConfig } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import type { RallarDiagnosticsPortsInput } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';

import {
    events,
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';
import { CrdtDocumentTestDouble } from './crdt-document-test-double.ts';

const CONNECTION = {
    connection: 'alm-recording',
    rallar: { apiBaseUrl: 'https://api.example.test', applicationId: 'app-1', username: 'alice', password: 'secret' }
};

beforeEach(() => resetFacade());
afterEach(() => vi.unstubAllGlobals());

function requirePorts(): RallarDiagnosticsPortsInput {
    const ports = facade.records.defaultWrites.at(-1)?.diagnosticsPorts;
    if (!ports) {
        throw new Error('Connection did not install diagnostics ports.');
    }
    return ports;
}

function publishAlmEvents(ports: RallarDiagnosticsPortsInput): void {
    ports.outboundDiagnostics?.({
        kind: 'congestion',
        carrier: 'rtc',
        cause: 'backpressured',
        action: 'defer',
        priority: 0,
        msgId: 'msg-1',
        traceId: 'trace-msg-1',
        corrId: 'msg-1'
    });
    ports.inboundDiagnostics?.({
        kind: 'admission-outcome',
        workerId: 'worker-1',
        msgId: 'msg-1',
        typeId: 'test.delivery',
        carrier: 'rtc',
        outcome: 'unauthorized',
        reason: 'unauthorized',
        traceId: 'trace-msg-1',
        corrId: 'msg-1'
    });
    ports.storage?.({ kind: 'ordering-tracks', storeId: 'store-1', tracks: 3 });
    ports.storage?.({
        kind: 'reset',
        storeId: 'store-1',
        event: { dbName: 'test', previousSchemaId: undefined, schemaId: 'current', reason: 'schema-id-mismatch' }
    });
}

function almTopics(): string[] {
    return events.filter((event) => event.topic?.startsWith('rallar.browser.alm.')).map((event) => event.topic);
}

it.each([undefined, true, false])('strictly decodes the optional ALM boolean %s', (almDiagnostics) => {
    expect(decodeBlackBoxRallarConnectionConfig({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics } }).rallar.almDiagnostics)
        .toBe(almDiagnostics);
});

it.each([
    { almDiagnostics: null },
    { almDiagnostics: 'false' },
    { almDiagnostics: 0 },
    { almDiagnostics: 1 },
    { almDiagnostics: {} },
    { almDiagnostics: [] }
])('rejects a non-boolean ALM setting $almDiagnostics at the wire boundary', ({ almDiagnostics }) => {
    expect(() => decodeBlackBoxRallarConnectionConfig({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics } }))
        .toThrow(TypeError);
});

it.each([undefined, true, false])('applies ALM recording %s while preserving observations and configuration evidence', async (almDiagnostics) => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics } });
    publishAlmEvents(requirePorts());

    expect(almTopics()).toEqual(
        almDiagnostics === false ? [] : [
            'rallar.browser.alm.outbound_diagnostics',
            'rallar.browser.alm.inbound_diagnostics',
            'rallar.browser.alm.storage',
            'rallar.browser.alm.storage_reset'
        ]
    );
    await expect(runtime.readCongestionCounters()).resolves.toEqual({
        dropped: 0,
        deferred: 1,
        handedOver: 0,
        rateLimited: 0,
        circuitOpen: 0,
        queuedBytesHighWater: 0
    });
    await expect(runtime.readAlmUsage()).resolves.toMatchObject({ orderingTracks: 3 });
    expect(events).toContainEqual(expect.objectContaining({
        topic: 'rallar.browser.connect.phase_completed',
        data: expect.objectContaining({ phase: 'rallar-connect', almDiagnostics: almDiagnostics !== false })
    }));
});

it('keeps prior callbacks and recorded history independent of later connection settings', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: true } });
    const recording = requirePorts();
    publishAlmEvents(recording);
    const recorded = events.filter((event) => event.topic?.startsWith('rallar.browser.alm.'));
    await runtime.close();
    const next = { ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } };
    await runtime.connect(next);
    const silent = requirePorts();
    next.rallar.almDiagnostics = true;
    publishAlmEvents(silent);
    expect(events.filter((event) => event.topic?.startsWith('rallar.browser.alm.'))).toEqual(recorded);
    publishAlmEvents(recording);
    expect(almTopics()).toHaveLength(8);
    await runtime.close();
    await runtime.connect(CONNECTION);
    publishAlmEvents(silent);
    expect(almTopics()).toHaveLength(8);
    publishAlmEvents(requirePorts());
    expect(almTopics()).toHaveLength(12);
});

it('keeps storage, transport and submission faults effective with recording Off', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } });
    const ports = requirePorts();
    await runtime.injectFault({ faultId: 'storage', carrier: 'storage', match: { owner: 'al-admission', kind: 'write' }, action: 'quota', remaining: 1 });
    await expect(ports.indexedDbOperationObserver?.observe({ owner: 'al-admission', kind: 'write' })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(ports.indexedDbOperationObserver?.observe({ owner: 'al-admission', kind: 'write' })).toBeUndefined();
    await expect(runtime.readStorageCounters({})).resolves.toMatchObject({
        total: 2,
        byOwner: { 'al-admission': 2, 'al-work': 0 },
        byKind: { write: 2 }
    });
    const frame = '{"id":{"msgId":"msg-1"},"payload":{"typeId":"test.delivery"}}';
    await runtime.injectFault({ faultId: 'transport', carrier: 'rtc', match: { typeId: 'test.delivery' }, action: 'drop', remaining: 1 });
    expect(ports.transportFaultPort?.decideSend('rtc', frame)).toEqual({ kind: 'drop', faultId: 'transport' });
    expect(ports.transportFaultPort?.decideSend('rtc', frame)).toEqual({ kind: 'pass' });
    await runtime.injectFault({ faultId: 'submission', carrier: 'ws', match: { typeId: 'test.delivery' }, action: 'not-ready', remaining: 1 });
    expect(ports.submissionReadinessFaultPort?.decideSubmissionReadiness(frame)).toBe('not-ready');
    expect(ports.submissionReadinessFaultPort?.decideSubmissionReadiness(frame)).toBe('ready');
    expect(almTopics()).toEqual([]);
});

it.each([undefined, 'off', 'native'] as const)('keeps RTC host and operation selection independent of ALM Off; host=%s', async (captureMode) => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({
        ...CONNECTION,
        rallar: { ...CONNECTION.rallar, almDiagnostics: false, rtc: { captureMode } }
    });
    const ports = requirePorts();
    ports.signalingDiagnostics?.({
        kind: 'service-signal-route',
        disposition: 'accepted-peer-result',
        result: undefined,
        localSessionId: 'session-1',
        peerSessionId: 'peer-1',
        signalType: 'Offer',
        offerId: 'offer-1',
        atEpochMs: 1
    });
    expect(facade.records.defaultWrites.at(-1)?.rtc?.captureMode).toBe(captureMode);
    expect(facade.records.connectionAttempts.at(-1)?.[0]).toMatchObject({
        rtcCaptureMode: undefined,
        rtcCaptureContext: undefined
    });
    expect(events).toContainEqual(expect.objectContaining({ topic: 'rallar.browser.rtc.signaling_diagnostics' }));
    expect(almTopics()).toEqual([]);
});

it('preserves unscoped default clearing with ALM Off', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({
        connection: 'unscoped',
        rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'secret', almDiagnostics: false }
    });
    expect(facade.records.defaultWrites.at(-1)).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
        topic: 'rallar.browser.connect.phase_completed',
        data: expect.objectContaining({ phase: 'configure' })
    }));
});

it('applies live CRDT configuration through the same recording owner', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    facade.behavior.crdtOpen.mockResolvedValue(new CrdtDocumentTestDouble({ documentId: 'doc-1', initialValue: { title: 'recording' } }));
    await runtime.crdt.open({
        name: 'recording',
        transport: 'ws',
        applicationId: 'app-1',
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        password: 'secret',
        rallar: { almDiagnostics: false }
    });
    publishAlmEvents(requirePorts());
    expect(almTopics()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
        topic: 'rallar.browser.crdt.configure_completed',
        data: expect.objectContaining({ almDiagnostics: false })
    }));
});

it('rejects differently configured queued reuse and preserves the active recording ports', async () => {
    const firstConnect = Promise.withResolvers<void>();
    facade.behavior.connect.mockReturnValueOnce(firstConnect.promise);
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        firstConnect.resolve();
        await runtime.close();
    });
    const first = runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } });
    await vi.waitFor(() => expect(facade.records.connectionAttempts).toHaveLength(1));
    const silent = requirePorts();
    const second = runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: true } });
    firstConnect.resolve();
    const rejected = expect(second).rejects.toThrow(/close.*reinitializ/i);
    await first;
    await rejected;
    publishAlmEvents(silent);
    expect(almTopics()).toEqual([]);
    publishAlmEvents(requirePorts());
    expect(almTopics()).toEqual([]);
    expect(facade.records.defaultWrites).toHaveLength(1);
});

it('keeps warnings, health and failed sends visible with ALM recording Off', async () => {
    const runtime = await loadRuntime();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(async () => {
        await runtime.close();
        warning.mockRestore();
    });
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } });
    console.warn('Unhandled WS message: recording-off');
    await expect(runtime.health()).resolves.toMatchObject({ connection: 'alm-recording' });
    facade.behavior.realtimeSend.mockRejectedValue(new Error('send-failure'));
    await expect(runtime.send({ peerIds: ['peer-1'], data: { text: 'test' } })).rejects.toThrow('send-failure');
    expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ topic: 'rallar.browser.ws.unhandled_message', severity: 'warning' }),
        expect.objectContaining({ topic: 'rallar.browser.realtime.send_failed', error: expect.objectContaining({ message: 'send-failure' }) })
    ]));
    expect(almTopics()).toEqual([]);
});

it('preserves recording for existing callers that omit the factory selection', () => {
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: () => 1,
        publish: (event) => {
            events.push(event);
        },
        onPublishError: (error) => {
            throw error;
        },
        transportOf: resolveBlackBoxRallarTransport,
        laneIdOf: resolveBlackBoxRallarLaneId,
        scopeDiagnostics: blackBoxRallarScopeDiagnosticsOf
    });
    publishAlmEvents(createBlackBoxRallarDiagnosticsPorts(diagnostics, facade.rallar.diagnostics));
    expect(almTopics()).toEqual([
        'rallar.browser.alm.outbound_diagnostics',
        'rallar.browser.alm.inbound_diagnostics',
        'rallar.browser.alm.storage',
        'rallar.browser.alm.storage_reset'
    ]);
});

it('retains delivery results, retry outcomes and receipts with ALM recording Off', async () => {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect({ ...CONNECTION, rallar: { ...CONNECTION.rallar, almDiagnostics: false } });
    const sent = await runtime.sendMessage({
        connection: 'alm-recording',
        carrier: 'ws',
        typeId: 'test.delivery',
        payload: { text: 'test' },
        handleId: 'receipt',
        timeoutMs: 100
    });
    expect(sent).toMatchObject({ handleId: 'receipt', carrier: 'ws', status: 'queued' });
    for (
        const attempt of [
            { attemptId: 'first', outcome: 'not-ready', submissionAttempted: false, willRetry: true },
            { attemptId: 'second', outcome: 'sent', submissionAttempted: true, willRetry: false }
        ] as const
    ) {
        facade.deliveries.record({
            kind: 'attempt-started',
            msgId: sent.msgId,
            carrier: 'ws',
            atMs: 1,
            attemptId: attempt.attemptId,
            traceId: 'trace-alm-recording'
        });
        facade.deliveries.record({
            kind: 'attempt-settled',
            msgId: sent.msgId,
            carrier: 'ws',
            atMs: 2,
            detail: undefined,
            ...attempt,
            traceId: 'trace-alm-recording'
        });
    }
    facade.deliveries.record({
        kind: 'acknowledgement',
        msgId: sent.msgId,
        carrier: 'ws',
        atMs: 3,
        mode: 'receiver',
        confirmedHopPeerIds: ['peer-1'],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['peer-1'],
        confirmedRecipientPeerIds: ['peer-1'],
        unconfirmedRecipientPeerIds: [],
        complete: true,
        traceId: 'trace-alm-recording'
    });
    await expect(runtime.readReceipts({ connection: 'alm-recording', handleId: 'receipt' })).resolves.toMatchObject({
        state: 'acknowledged',
        submitted: true,
        attempts: 2,
        attemptOutcomes: ['not-ready', 'sent'],
        confirmedRecipientPeerIds: ['peer-1'],
        unconfirmedRecipientPeerIds: []
    });
    expect(almTopics()).toEqual([]);
});
