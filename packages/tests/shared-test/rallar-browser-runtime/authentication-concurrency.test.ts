import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { facade, loadRuntime as loadOptionalAuthenticationRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';
import { createDeferred } from './browser-runtime-lifecycle-test-fixture.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function loadRuntime(): Promise<BlackBoxRallarRuntime & Required<Pick<BlackBoxRallarRuntime, 'authenticate'>>> {
    const runtime = await loadOptionalAuthenticationRuntime();
    assertAuthenticationAvailable(runtime);
    return runtime;
}

function assertAuthenticationAvailable(
    runtime: BlackBoxRallarRuntime
): asserts runtime is BlackBoxRallarRuntime & Required<Pick<BlackBoxRallarRuntime, 'authenticate'>> {
    if (runtime.authenticate === undefined) {
        throw new Error('The browser runtime under test does not expose authentication.');
    }
}

it('deduplicates auth bootstrap and reuses its restored session for full connect', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();
    const config = {
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed' as const
        }
    };

    const firstAuthentication = runtime.authenticate(config);
    const secondAuthentication = runtime.authenticate(config);
    expect(facade.records.registrationAttempts).toHaveLength(1);

    registration.resolve(facade.session);
    await Promise.all([firstAuthentication, secondAuthentication]);
    facade.behavior.restore.mockReturnValue(facade.session);

    await runtime.connect({
        ...config,
        connection: 'aliceRtc',
        roomId: 'room-1'
    });

    expect(facade.records.registrationAttempts).toHaveLength(1);
    expect(facade.records.restoreCount).toBeGreaterThan(0);
    expect(facade.records.connectionAttempts).toHaveLength(1);
    expect(facade.records.roomJoins).toHaveLength(1);
});

it('preserves logout cleanup when connect reuses an authenticated session', async () => {
    const runtime = await loadRuntime();
    const authentication = {
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        password: 'secret'
    };
    await runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            ...authentication,
            logoutOnClose: true
        }
    });
    facade.behavior.restore.mockReturnValue(facade.session);

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            ...authentication,
            logoutOnClose: false
        }
    });
    const diagnostics = await runtime.close();

    expect(facade.records.logoutAttempts).toHaveLength(1);
    expect(facade.records.disconnectCount).toBe(0);
    expect(diagnostics).toMatchObject({
        status: 'closed',
        connection: 'aliceRtc',
        roomId: 'room-1',
        logout: true,
        disconnected: false
    });
});

it('shares an in-flight authentication bootstrap with connect', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();
    const authentication = runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });
    const connection = runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });

    expect(facade.records.registrationAttempts).toHaveLength(1);
    registration.resolve(facade.session);
    await Promise.all([authentication, connection]);

    expect(facade.records.registrationAttempts).toHaveLength(1);
    expect(facade.records.connectionAttempts).toHaveLength(1);
});

it('preserves each caller context while deduplicating same-identity auth bootstrap', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();

    const firstAuthentication = runtime.authenticate({
        connection: 'firstHttp',
        actor: 'first-actor',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed',
            logoutOnClose: false
        }
    });
    const secondAuthentication = runtime.authenticate({
        connection: 'secondHttp',
        actor: 'second-actor',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed',
            applicationId: 'app-2',
            workspaceId: 'workspace-2',
            logoutOnClose: true
        }
    });
    expect(facade.records.registrationAttempts).toHaveLength(1);

    registration.resolve(facade.session);
    await expect(firstAuthentication).resolves.toMatchObject({
        connection: 'firstHttp',
        actor: 'first-actor'
    });
    await expect(secondAuthentication).resolves.toMatchObject({
        connection: 'secondHttp',
        actor: 'second-actor',
        applicationId: 'app-2',
        workspaceId: 'workspace-2'
    });

    const closeDiagnostics = await runtime.close();
    expect(facade.records.logoutAttempts).toHaveLength(1);
    expect(closeDiagnostics).toMatchObject({
        connection: 'secondHttp',
        actor: 'second-actor',
        logout: true
    });
});

it('preserves logout cleanup when a later shared-auth caller disables it', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();
    const sharedIdentity = {
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        password: 'secret',
        register: 'if-needed' as const
    };

    const firstAuthentication = runtime.authenticate({
        connection: 'firstHttp',
        actor: 'first-actor',
        rallar: {
            ...sharedIdentity,
            logoutOnClose: true
        }
    });
    const secondAuthentication = runtime.authenticate({
        connection: 'secondHttp',
        actor: 'second-actor',
        rallar: {
            ...sharedIdentity,
            logoutOnClose: false
        }
    });

    registration.resolve(facade.session);
    await Promise.all([firstAuthentication, secondAuthentication]);
    const closeDiagnostics = await runtime.close();

    expect(facade.records.logoutAttempts).toHaveLength(1);
    expect(facade.records.disconnectCount).toBe(0);
    expect(closeDiagnostics).toMatchObject({
        connection: 'secondHttp',
        actor: 'second-actor',
        logout: true,
        disconnected: false
    });
});

it('records provenance before a queued restore-only identity can authenticate', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();

    const aliceAuthentication = runtime.authenticate({
        connection: 'aliceHttp',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed'
        }
    });
    const bobAuthentication = runtime.authenticate({
        connection: 'bobRestore',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob'
        }
    });
    const bobRejection = expect(bobAuthentication).rejects.toThrow(
        'Rallar credentials are required when the authentication identity changes.'
    );
    facade.behavior.restore.mockReturnValue(facade.session);

    registration.resolve(facade.session);

    await expect(aliceAuthentication).resolves.toMatchObject({
        status: 'authenticated',
        username: 'alice'
    });
    await bobRejection;
    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });
});

it('does not restore stale cleanup state when a queued identity login fails', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    facade.behavior.login.mockRejectedValueOnce(new Error('bad credentials'));
    const runtime = await loadRuntime();

    const aliceAuthentication = runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            register: 'if-needed',
            logoutOnClose: true
        }
    });
    const bobAuthentication = runtime.authenticate({
        connection: 'bobHttp',
        actor: 'bob',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'wrong',
            register: false
        }
    });
    const bobRejection = expect(bobAuthentication).rejects.toThrow(
        'bad credentials'
    );

    registration.resolve(facade.session);

    await expect(aliceAuthentication).resolves.toMatchObject({
        status: 'authenticated',
        username: 'alice'
    });
    await bobRejection;

    const closeDiagnostics = await runtime.close();
    expect(facade.records.logoutAttempts).toHaveLength(0);
    expect(facade.records.disconnectCount).toBe(1);
    expect(closeDiagnostics).toMatchObject({
        connection: undefined,
        logout: false,
        disconnected: true
    });
});

it('uses the latest authenticated identity for cleanup when full connect fails after a switch', async () => {
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
    const bobSession = {
        ...facade.session,
        clientId: 'client-2',
        sessionId: 'session-2',
        username: 'bob'
    };
    facade.behavior.login.mockResolvedValue(bobSession);
    facade.behavior.connect.mockRejectedValueOnce(new Error('realtime unavailable'));

    await expect(runtime.connect({
        connection: 'bobRtc',
        actor: 'bob',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'other-secret'
        }
    })).rejects.toThrow('realtime unavailable');
    const diagnostics = await runtime.close();

    expect(facade.records.logoutAttempts).toHaveLength(0);
    expect(facade.records.disconnectCount).toBe(1);
    expect(diagnostics).toMatchObject({
        status: 'closed',
        connection: 'bobRtc',
        actor: 'bob',
        logout: false,
        disconnected: true
    });
});

it('waits for cancelled authentication and owns its logout cleanup', async () => {
    const login = createDeferred<typeof facade.session>();
    facade.behavior.login.mockReturnValue(login.promise);
    const runtime = await loadRuntime();
    const authentication = runtime.authenticate({
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            logoutOnClose: true
        }
    });
    const rejectedAuthentication = expect(authentication).rejects.toThrow(
        'Authentication was cancelled because the Rallar runtime closed.'
    );
    expect(facade.records.loginAttempts).toHaveLength(1);
    facade.behavior.restore.mockReturnValue(facade.session);

    const closing = runtime.close();
    await Promise.resolve();
    expect(facade.records.logoutAttempts).toHaveLength(0);
    expect(facade.records.disconnectCount).toBe(0);
    login.resolve(facade.session);
    await rejectedAuthentication;
    const closeDiagnostics = await closing;

    expect(closeDiagnostics).toMatchObject({
        status: 'closed',
        connection: 'aliceHttp',
        actor: 'alice',
        logout: true,
        disconnected: false
    });
    expect(facade.records.logoutAttempts).toHaveLength(1);
    const secondCloseDiagnostics = await runtime.close();
    expect(secondCloseDiagnostics.connection).toBeUndefined();
    expect(facade.records.logoutAttempts).toHaveLength(1);
});

it('honors every caller cleanup policy when shared authentication completes after close', async () => {
    const registration = createDeferred<typeof facade.session>();
    facade.behavior.registerAndLogin.mockReturnValue(registration.promise);
    const runtime = await loadRuntime();
    const sharedIdentity = {
        apiBaseUrl: 'https://api.example.test',
        username: 'alice',
        password: 'secret',
        register: 'if-needed' as const
    };
    const firstAuthentication = runtime.authenticate({
        connection: 'firstHttp',
        rallar: {
            ...sharedIdentity,
            logoutOnClose: false
        }
    });
    const secondAuthentication = runtime.authenticate({
        connection: 'secondHttp',
        rallar: {
            ...sharedIdentity,
            logoutOnClose: true
        }
    });
    const firstRejection = expect(firstAuthentication).rejects.toThrow(
        'Authentication was cancelled because the Rallar runtime closed.'
    );
    const secondRejection = expect(secondAuthentication).rejects.toThrow(
        'Authentication was cancelled because the Rallar runtime closed.'
    );
    facade.behavior.restore.mockReturnValue(facade.session);

    const closing = runtime.close();
    registration.resolve(facade.session);
    await Promise.all([firstRejection, secondRejection]);
    await closing;

    expect(facade.records.registrationAttempts).toHaveLength(1);
    expect(facade.records.logoutAttempts).toHaveLength(1);
});

it('rejects retries until aborted authentication and close settle', async () => {
    const firstLogin = createDeferred<typeof facade.session>();
    let firstLoginSignal: AbortSignal | undefined;
    facade.behavior.login
        .mockImplementationOnce((_request, options) => {
            firstLoginSignal = options?.signal;
            return firstLogin.promise;
        })
        .mockResolvedValueOnce(facade.session);
    const runtime = await loadRuntime();
    const config = {
        connection: 'aliceHttp',
        actor: 'alice',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    };
    const cancelledAuthentication = runtime.authenticate(config);
    const cancelledResult = expect(cancelledAuthentication).rejects.toThrow(
        'Authentication was cancelled because the Rallar runtime closed.'
    );
    const closing = runtime.close();
    await Promise.resolve();

    await expect(runtime.authenticate(config)).rejects.toThrow(
        'Authentication was cancelled because the Rallar runtime closed.'
    );
    expect(facade.records.loginAttempts).toHaveLength(1);

    firstLogin.resolve(facade.session);
    await cancelledResult;
    await closing;

    const retry = runtime.authenticate(config);
    await expect(retry).resolves.toMatchObject({
        status: 'authenticated',
        sessionId: 'session-1'
    });
    expect(firstLoginSignal?.aborted).toBe(true);
    expect(facade.records.loginAttempts).toHaveLength(2);
});
