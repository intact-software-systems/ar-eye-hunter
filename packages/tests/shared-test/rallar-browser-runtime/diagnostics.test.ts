import {
    afterEach,
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';
import {
    events,
    facade,
    loadRuntime,
    resetFacade,
    topics
} from './browser-rallar-runtime-test-harness.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('emits auth restore failure diagnostics when no session or credentials exist', async () => {
    const runtime = await loadRuntime();

    await expect(runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test'
        }
    })).rejects.toThrow('Rallar credentials are required');

    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.auth.restore_started',
        'rallar.browser.auth.restore_failed',
        'rallar.browser.connect.phase_failed',
        'rallar.browser.connect_failed'
    ]));
});

it('emits login failure diagnostics for bad credentials', async () => {
    facade.behavior.login.mockRejectedValue(new Error('bad credentials'));
    const runtime = await loadRuntime();

    await expect(runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'wrong'
        }
    })).rejects.toThrow('bad credentials');

    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.auth.login_started',
        'rallar.browser.auth.login_failed',
        'rallar.browser.connect.phase_failed'
    ]));
});

it('omits browser RTC diagnostics counters from default health snapshots', async () => {
    const runtime = await loadRuntime();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            transport: 'realtime',
            laneId: 'control-lane'
        }
    });

    const health = await runtime.health();

    expect(facade.records.rtcDiagnosticsReads).toHaveLength(0);
    expect(health).not.toHaveProperty('rtcDiagnostics');
    expect(health).not.toHaveProperty('rtcDiagnosticsError');
});

it('includes browser RTC diagnostics counters in health snapshots when requested', async () => {
    const runtime = await loadRuntime();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            transport: 'realtime',
            laneId: 'control-lane'
        }
    });

    const health = await runtime.health({ includeRtcDiagnostics: true });

    expect(facade.records.rtcDiagnosticsReads).toContainEqual([{
        laneIds: ['control-lane']
    }]);
    expect(health).toMatchObject({
        rtcDiagnostics: {
            peerCount: 1,
            peers: [{
                peerId: 'peer-1',
                connectionDiagnostics: {
                    connectCallCount: 1,
                    outboundOfferCount: 1,
                    inboundAnswerCount: 1
                }
            }]
        }
    });
});

it('bridges relevant browser console warnings into structured diagnostics', async () => {
    const runtime = await loadRuntime();
    const originalWarn = console.warn;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });

    console.warn('Unhandled WS message: room.unknown');
    console.warn('Received data channel for different data channel name: rtc-data-channel vs rtc-realtime');

    expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            severity: 'warning',
            data: expect.objectContaining({
                message: 'Unhandled WS message: room.unknown'
            })
        }),
        expect.objectContaining({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.data_channel_warning',
            transport: 'realtime',
            severity: 'warning',
            data: expect.objectContaining({
                message: 'Received data channel for different data channel name: rtc-data-channel vs rtc-realtime'
            })
        })
    ]));

    await runtime.close();
    warnSpy.mockRestore();
    expect(console.warn).toBe(originalWarn);
});

it('keeps warning diagnostics serializable when native console arguments are circular', async () => {
    const runtime = await loadRuntime();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(async () => {
        try {
            await runtime.close();
        }
        finally {
            warnSpy.mockRestore();
        }
    });
    await runtime.connect({
        connection: 'aliceRtc',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });

    const circularArgument: object[] = [];
    circularArgument.push(circularArgument);
    console.warn('Unhandled WS message: circular', circularArgument);

    const nativeWarning = warnSpy.mock.calls.at(-1);
    expect(nativeWarning?.[0]).toBe('Unhandled WS message: circular');
    expect(nativeWarning?.[1]).toBe(circularArgument);
    expect(events.at(-1)).toMatchObject({
        kind: 'diagnostic',
        topic: 'rallar.browser.ws.unhandled_message',
        severity: 'warning',
        data: { message: 'Unhandled WS message: circular ' }
    });
    expect(() => JSON.stringify(events.at(-1))).not.toThrow();
});

it('emits room join failure diagnostics for permission-style failures', async () => {
    facade.behavior.roomJoin.mockRejectedValue(new Error('forbidden room'));
    const runtime = await loadRuntime();

    await expect(runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'forbidden-room',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    })).rejects.toThrow('forbidden room');

    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.connect.phase_started',
        'rallar.browser.connect.phase_failed',
        'rallar.browser.connect_failed'
    ]));
});

it('emits send failure diagnostics for forbidden targets', async () => {
    facade.behavior.realtimeSend.mockRejectedValue(new Error('forbidden target'));
    const runtime = await loadRuntime();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });
    await expect(runtime.send({
        roomId: 'room-1',
        peerIds: ['forbidden-session'],
        data: {
            text: 'hello'
        }
    })).rejects.toThrow('forbidden target');

    expect(topics()).toContain('rallar.browser.realtime.send_failed');
});

it('emits expected-session and duplicate-session diagnostics', async () => {
    const runtime = await loadRuntime();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            expectedSessionId: 'expected-session'
        }
    });
    await runtime.connect({
        connection: 'aliceRtc2',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            expectedSessionId: 'session-1'
        }
    });

    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.session.expected_mismatch',
        'rallar.browser.session.duplicate_detected',
        'rallar.browser.cleanup.unsubscribe_completed'
    ]));
});
