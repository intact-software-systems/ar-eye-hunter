import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { facade, loadRuntime, resetFacade, topics } from './browser-rallar-runtime-test-harness.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('authenticates without initializing realtime middleware or connected runtime state', async () => {
    const runtime = await loadRuntime();

    const diagnostics = await runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });

    expect(diagnostics).toEqual({
        status: 'authenticated',
        connection: 'aliceHttp',
        actor: 'alice',
        clientId: 'client-1',
        sessionId: 'session-1',
        username: 'alice'
    });
    expect(JSON.stringify(diagnostics)).not.toContain('access-token-1');
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    expect(facade.records.configurationWrites).toContainEqual({
        apiBaseUrl: 'https://api.example.test'
    });
    expect(facade.records.registrationAttempts).toHaveLength(1);
    expect(facade.records.defaultWrites).toHaveLength(0);
    expect(facade.records.connectionAttempts).toHaveLength(0);
    expect(facade.records.roomJoins).toHaveLength(0);
    expect(facade.records.realtimeSubscriptions.length).toBe(0);
    expect(facade.records.rtcMessageSubscriptions.length).toBe(0);
    await expect(runtime.send({ data: 'not-connected' }))
        .rejects.toThrow('Black-box Rallar runtime is not connected.');
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.authenticate_started',
        'rallar.browser.auth.register_started',
        'rallar.browser.auth.register_completed',
        'rallar.browser.authenticate_completed'
    ]));
    expect(topics()).not.toContain('rallar.browser.connect_started');
});

it('requires connected runtime cleanup before a fresh auth-only login', async () => {
    const runtime = await loadRuntime();
    const rallarConfig = {
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        password: 'secret'
    };
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            ...rallarConfig,
            leaveRoomOnClose: true
        }
    });
    expect(facade.records.loginAttempts).toHaveLength(1);

    await expect(runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: rallarConfig
    })).rejects.toThrow(
        'Fresh Rallar authentication requires closing the connected black-box runtime first.'
    );

    expect(facade.records.loginAttempts).toHaveLength(1);
    expect(facade.records.realtimeUnsubscribeCount).toBe(0);

    const closeDiagnostics = await runtime.close();
    expect(facade.records.roomLeaves).toContainEqual([{
        roomId: 'room-1',
        clearCurrent: true,
        timeoutMs: undefined
    }]);
    expect(closeDiagnostics).toMatchObject({
        status: 'closed',
        connection: 'aliceRtc',
        roomId: 'room-1',
        leftRoom: true
    });
    expect(facade.records.realtimeUnsubscribeCount).toBe(1);
});

it.each([
    {
        mismatch: 'API base URL',
        apiBaseUrl: 'https://other-api.example.test',
        username: 'alice',
        restoredSession: facade.session
    },
    {
        mismatch: 'username',
        apiBaseUrl: 'https://api.example.test',
        username: 'bob',
        restoredSession: facade.session
    },
    {
        mismatch: 'restored session',
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        restoredSession: {
            ...facade.session,
            sessionId: 'session-2'
        }
    }
])('does not reuse auth bootstrap after a $mismatch mismatch', async ({
    apiBaseUrl,
    username,
    restoredSession
}) => {
    const runtime = await loadRuntime();
    await runtime.authenticate({
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test/',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });
    facade.behavior.restore.mockReturnValue(restoredSession);

    await runtime.connect({
        connection: 'rtc',
        rallar: {
            apiBaseUrl,
            username,
            password: 'secret',
            register: 'if-needed'
        }
    });

    expect(facade.records.registrationAttempts).toHaveLength(2);
});

it.each([
    {
        operation: 'authenticate',
        mismatch: 'API base URL',
        apiBaseUrl: 'https://other-api.example.test',
        username: 'alice'
    },
    {
        operation: 'authenticate',
        mismatch: 'username',
        apiBaseUrl: 'https://api.example.test',
        username: 'bob'
    },
    {
        operation: 'connect',
        mismatch: 'API base URL',
        apiBaseUrl: 'https://other-api.example.test',
        username: 'alice'
    },
    {
        operation: 'connect',
        mismatch: 'username',
        apiBaseUrl: 'https://api.example.test',
        username: 'bob'
    }
])('requires fresh credentials for $operation after a bootstrap $mismatch mismatch', async ({
    operation,
    apiBaseUrl,
    username
}) => {
    const runtime = await loadRuntime();
    await runtime.authenticate({
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });
    facade.behavior.restore.mockReturnValue(facade.session);

    const config = {
        connection: operation,
        rallar: {
            apiBaseUrl,
            username
        }
    };
    const result = operation === 'authenticate'
        ? runtime.authenticate(config)
        : runtime.connect(config);

    await expect(result).rejects.toThrow(
        'Rallar credentials are required when the authentication identity changes.'
    );
    expect(facade.records.registrationAttempts).toHaveLength(1);
    expect(facade.records.loginAttempts).toHaveLength(0);
    expect(facade.records.connectionAttempts).toHaveLength(0);
});

it('keeps a known cross-API session rejected after fresh authentication fails', async () => {
    const runtime = await loadRuntime();
    await runtime.authenticate({
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });
    facade.behavior.restore.mockReturnValue(facade.session);
    facade.behavior.login.mockRejectedValueOnce(new Error('bad credentials'));

    await expect(runtime.authenticate({
        connection: 'bobHttp',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'wrong'
        }
    })).rejects.toThrow('bad credentials');

    await expect(runtime.authenticate({
        connection: 'bobRestore',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob'
        }
    })).rejects.toThrow(
        'Rallar credentials are required when the authentication identity changes.'
    );
    expect(facade.records.loginAttempts).toHaveLength(1);
});

it('honors logout cleanup after auth-only bootstrap', async () => {
    const runtime = await loadRuntime();

    await runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            logoutOnClose: true
        }
    });
    const diagnostics = await runtime.close();

    expect(facade.records.logoutAttempts).toContainEqual([{ timeoutMs: undefined }]);
    expect(facade.records.disconnectCount).toBe(0);
    expect(diagnostics).toMatchObject({
        status: 'closed',
        connection: 'aliceHttp',
        actor: 'alice',
        logout: true,
        disconnected: false
    });
});

it('preserves authentication on auth-only close when logout is disabled', async () => {
    const runtime = await loadRuntime();

    await runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });
    const diagnostics = await runtime.close();

    expect(facade.records.logoutAttempts).toHaveLength(0);
    expect(facade.records.disconnectCount).toBe(1);
    expect(diagnostics).toMatchObject({
        status: 'closed',
        connection: 'aliceHttp',
        actor: 'alice',
        logout: false,
        disconnected: true
    });
});

it('reports invalid auth bootstrap configuration and allows a corrected retry', async () => {
    const runtime = await loadRuntime();

    await expect(runtime.authenticate({
        connection: 'invalidHttp',
        rallar: {
            apiBaseUrl: '',
            username: 'alice',
            password: 'secret'
        }
    })).rejects.toThrow('rallar.apiBaseUrl is required.');
    expect(topics()).toContain('rallar.browser.authenticate_failed');

    await expect(runtime.authenticate({
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    })).resolves.toMatchObject({
        status: 'authenticated',
        sessionId: 'session-1'
    });
    expect(facade.records.loginAttempts).toHaveLength(1);
});

it('clears failed auth bootstrap state before retrying the same identity', async () => {
    facade.behavior.login.mockRejectedValueOnce(new Error('temporary auth failure'));
    const runtime = await loadRuntime();
    const config = {
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    };

    await expect(runtime.authenticate(config)).rejects.toThrow('temporary auth failure');
    facade.behavior.login.mockResolvedValue(facade.session);
    await expect(runtime.authenticate(config)).resolves.toMatchObject({
        status: 'authenticated',
        sessionId: 'session-1'
    });

    expect(facade.records.loginAttempts).toHaveLength(2);
    expect(topics()).toContain('rallar.browser.authenticate_failed');
});
