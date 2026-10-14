import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import {
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';
import { createDeferred } from './browser-runtime-lifecycle-test-fixture.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('refreshes connected room state with the caller deadline and signal', async () => {
    const runtime = await loadRuntime();
    const controller = new AbortController();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-a',
            workspaceId: 'workspace-a',
            timeoutMs: 1_234
        }
    });

    await runtime.refreshRoom({
        signal: controller.signal,
        timeoutMs: 321
    });

    expect(facade.records.roomStateRefreshes).toContainEqual([{
        applicationId: 'app-a',
        workspaceId: 'workspace-a',
        groupId: 'room-1'
    }, {
        scope: {
            applicationId: 'app-a',
            workspaceId: 'workspace-a'
        },
        signal: controller.signal,
        timeoutMs: 321
    }]);
    expect(facade.records.roomRefreshes).toHaveLength(0);
});

it('rejects room refresh when the connected config has no exact room reference', async () => {
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
    await expect(runtime.refreshRoom({ timeoutMs: 321 })).rejects.toMatchObject({
        name: 'RallarValidationError',
        issues: [
            {
                path: '$.roomRef',
                code: 'room-ref-required'
            }
        ]
    });

    expect(facade.records.roomRefreshes).toHaveLength(0);
});

it('rejects a connected identity change before mutating facade configuration', async () => {
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

    if (runtime.authenticate === undefined) {
        throw new Error('The browser runtime under test does not expose authentication.');
    }
    await expect(runtime.authenticate({
        connection: 'bobHttp',
        actor: 'bob',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'secret'
        }
    })).rejects.toThrow(
        'Fresh Rallar authentication requires closing the connected black-box runtime first.'
    );

    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });
});

it('revalidates a queued connection target before mutating the facade', async () => {
    const firstConnect = createDeferred<void>();
    facade.behavior.connect.mockReturnValueOnce(firstConnect.promise);
    const runtime = await loadRuntime();
    const first = runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });
    await vi.waitFor(() => {
        expect(facade.records.connectionAttempts).toHaveLength(1);
    });

    const second = runtime.connect({
        connection: 'bobRtc',
        actor: 'bob',
        roomId: 'room-2',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'other-secret'
        }
    });
    const secondResult = expect(second).rejects.toThrow(
        'Connected Rallar identity, scope, or room changes require close first.'
    );
    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });

    firstConnect.resolve(undefined);
    await first;
    await secondResult;
    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });
    expect(facade.records.connectionAttempts).toHaveLength(1);
});

it('holds a connect\'s lowered volatile limits for the session the facade initialises, and the constants after', async () => {
    const volatileLimits = new BlackBoxRallarVolatileLimits();
    const runtime = await loadRuntime(volatileLimits);
    const read: ALVolatileSessionLimits[] = [];
    facade.behavior.connect.mockImplementation(async () => {
        read.push(volatileLimits.get());
    });
    const config = {
        connection: 'aliceAlm',
        actor: 'alice',
        rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'secret' }
    };

    await runtime.connect({
        ...config,
        rallar: { ...config.rallar, almVolatileLimits: { ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 2, maxBytes: 4_096 } }
    });
    await runtime.close();
    await runtime.connect(config);
    await runtime.close();

    // The facade initialises its session inside `connect`, so what it reads there is what the session keeps.
    expect(read).toEqual([
        { ...AL_VOLATILE_SESSION_LIMITS, maxAdmissions: 2, maxBytes: 4_096 },
        AL_VOLATILE_SESSION_LIMITS
    ]);
});
