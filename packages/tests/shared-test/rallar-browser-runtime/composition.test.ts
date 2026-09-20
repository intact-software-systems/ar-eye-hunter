import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import {
    createBlackBoxRallarRuntime,
    installBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import * as BrowserRuntimeComposition from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { createAlmConformanceRecipes } from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';

import { facade, resetFacade } from './browser-rallar-runtime-test-harness.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('reports the native document in connect and health from the installed runtime', async () => {
    vi.spyOn(BrowserRuntimeComposition, 'createBlackBoxBrowserRallarRuntimeDependency').mockReturnValue(facade.rallar);
    vi.stubGlobal('location', { origin: 'https://installed.example.test' });
    const timeOrigin = performance.timeOrigin;
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {};

    const runtime = installBlackBoxRallarRuntime(targetWindow);

    expect(targetWindow.__blackBoxRallar).toBe(runtime);
    try {
        const connected = await runtime.connect({
            connection: 'installed',
            rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'secret' }
        });
        expect.soft(connected).toMatchObject({ document: { timeOrigin, origin: 'https://installed.example.test' } });
        expect.soft(await runtime.health()).toMatchObject({ document: { timeOrigin, origin: 'https://installed.example.test' } });
    }
    finally {
        await runtime.close();
    }
});

it.each([1700000000000.25, 1700000001234.5])('reports injected document generation %s independently of the diagnostic clock', async (timeOrigin) => {
    const factoryEvents: BlackBoxRallarEvent[] = [];
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event: BlackBoxRallarEvent) => {
            factoryEvents.push(event);
        }
    };
    const runtime = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow,
        clock: {
            now: () => 12_345
        },
        delay: async () => undefined,
        readDocument: () => ({ timeOrigin, origin: 'https://injected.example.test' })
    });
    try {
        const connected = await runtime.connect({
            connection: 'factoryConnection',
            actor: 'alice',
            rallar: {
                apiBaseUrl: 'https://api.example.test',
                username: 'alice',
                password: 'secret'
            }
        });
        expect.soft(connected).toMatchObject({ document: { timeOrigin, origin: 'https://injected.example.test' } });
        expect.soft(await runtime.health()).toMatchObject({ document: { timeOrigin, origin: 'https://injected.example.test' } });
    }
    finally {
        await runtime.close();
    }

    expect(targetWindow.__blackBoxRallar).toBeUndefined();
    expect(factoryEvents.length).toBeGreaterThan(0);
    expect(factoryEvents.every((event) => event.atEpochMs === 12_345)).toBe(true);
});

it('fresh authored reconnect overrides configured credentials and restores the same session through the browser adapter', async () => {
    const createDocument = (timeOrigin: number) =>
        createBlackBoxRallarRuntime({
            facade: facade.rallar,
            targetWindow: {},
            clock: { now: Date.now },
            delay: async () => undefined,
            readDocument: () => ({ timeOrigin, origin: 'https://restored.example.test' })
        });
    const initial = createDocument(100);
    const before = await initial.connect({
        connection: 'sender',
        rallar: { apiBaseUrl: 'https://api.example.test', username: 'alice', password: 'initial-password', logoutOnClose: false }
    });
    expect(before).toMatchObject({
        clientId: facade.session.clientId,
        sessionId: facade.session.sessionId,
        document: { timeOrigin: 100, origin: 'https://restored.example.test' }
    });
    await initial.close();
    const stored = new Map([['auth.session', JSON.stringify(facade.session)]]);
    vi.stubGlobal(
        'localStorage',
        {
            get length() {
                return stored.size;
            },
            clear: () => stored.clear(),
            getItem: (key: string) => stored.get(key) ?? null,
            key: (index: number) => [...stored.keys()][index] ?? null,
            removeItem: (key: string) => {
                stored.delete(key);
            },
            setItem: (key: string, value: string) => {
                stored.set(key, value);
            }
        } satisfies Storage
    );
    facade.behavior.restore.mockReturnValue(facade.session);
    facade.behavior.login.mockRejectedValue(new Error('A reload must not log in again.'));
    facade.behavior.registerAndLogin.mockRejectedValue(new Error('A reload must not register again.'));
    const fresh = createDocument(200);
    vi.stubGlobal('window', { __blackBoxRallar: fresh } satisfies BlackBoxRallarRuntimeInstallationTarget);
    const adapter = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime: createSpaBrowserRallarRuntime() });
    try {
        await adapter.execute({
            kind: 'configure',
            config: {
                apiBaseUrl: 'https://api.example.test',
                rallar: { apiBaseUrl: 'https://api.example.test', username: 'configured-other-user', password: 'configured-password', register: 'if-needed' }
            }
        });
        const recipe = createAlmConformanceRecipes({
            group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
            carrier: 'ws',
            typeId: 'restore-proof',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 18_000
        }).find((scenario) => scenario.scenarioId === 'delivery-reload')!.sender;
        const reconnect = recipe.commands[recipe.commands.findIndex((command) => command.kind === 'agent.reload') + 1];
        const after = await adapter.execute(reconnect);
        expect(after.ok, JSON.stringify(after.error)).toBe(true);
        expect(after.value).toMatchObject({
            clientId: before.clientId,
            sessionId: before.sessionId,
            document: { timeOrigin: 200, origin: 'https://restored.example.test' }
        });
        expect(await fresh.health()).toMatchObject({ session: { clientId: before.clientId, sessionId: before.sessionId } });
    }
    finally {
        await adapter.execute({ kind: 'close' });
        localStorage.removeItem('auth.session');
    }
});
