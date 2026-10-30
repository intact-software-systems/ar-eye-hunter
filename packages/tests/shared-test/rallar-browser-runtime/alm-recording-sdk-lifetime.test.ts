import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { BlackBoxRallarEvent } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { BlackBoxRallarVolatileLimits } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts';
import { createRallarFacade } from '@shared-web/browser/composition/create-rallar-facade.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import {
    JsonWebSocketClient,
    type OnWebSocketMessageCallback
} from '@shared/websocket/json-web-socket-client.ts';

import {
    CAPTURE_APPLICATION_API_CONFIG,
    createCaptureApplicationRuntime,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

const CONFIG = {
    connection: 'sdk-alm',
    rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'default' }
};

function appliedConfigurations(events: readonly BlackBoxRallarEvent[]): BlackBoxRallarEvent[] {
    return events.filter((event) =>
        (event.topic === 'rallar.browser.crdt.configure_completed' || event.topic === 'rallar.browser.connect.phase_completed') &&
        typeof event.data === 'object' && event.data !== null && 'almDiagnostics' in event.data
    );
}

it.each([true, false])('rejects actual SDK active and queued policy changes from %s before defaults mutation', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    const defaults = vi.spyOn(facade, 'setDefaults');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    onTestFinished(() => release.resolve());
    vi.spyOn(connectionHttp, 'readApiConfig').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return CAPTURE_APPLICATION_API_CONFIG;
    });
    const first = page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics } });
    await entered.promise;
    const queued = page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics: !almDiagnostics } })
        .then(() => 'accepted', (error: Error) => error.message);
    const writes = defaults.mock.calls.length;
    release.resolve();
    await first;
    expect(await queued).toMatch(/close.*reinitializ/i);
    expect(defaults.mock.calls).toHaveLength(writes);
    expect(appliedConfigurations(events)).toHaveLength(1);
    await expect(page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics: !almDiagnostics } }))
        .rejects.toThrow(/close.*reinitializ/i);
    expect(defaults.mock.calls).toHaveLength(writes);
    expect(appliedConfigurations(events)).toHaveLength(1);
    expect(facade.isConnected()).toBe(true);
});

it.each([true, false])('rejects connected CRDT reuse with the opposite policy to %s', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    await page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics } });
    const defaults = vi.spyOn(facade, 'setDefaults');
    await expect(page.crdt.open({
        name: 'conflict',
        transport: 'ws',
        apiBaseUrl: CONFIG.rallar.apiBaseUrl,
        applicationId: 'app',
        workspaceId: 'default',
        rallar: { almDiagnostics: !almDiagnostics }
    })).rejects.toThrow(/close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
    expect(appliedConfigurations(events)).toHaveLength(1);
    await expect(page.crdt.open({ name: 'implicit-conflict', transport: 'ws', rallar: { almDiagnostics: !almDiagnostics } }))
        .rejects.toThrow(/close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
    expect(facade.isConnected()).toBe(true);
});

it.each([true, false])('allows matching policy reuse and applies the opposite only after explicit close from %s', async (almDiagnostics) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    await page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics } });
    const receipt = facade.rtcCapture();
    const defaults = vi.spyOn(facade, 'setDefaults');
    await page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics: almDiagnostics ? undefined : false } });
    expect(defaults).not.toHaveBeenCalled();
    expect(facade.rtcCapture()).toBe(receipt);
    await page.close();
    await page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics: !almDiagnostics } });
    expect(defaults).toHaveBeenCalledTimes(1);
    expect(facade.rtcCapture()).not.toBe(receipt);
    expect(appliedConfigurations(events).at(-1)).toMatchObject({ data: { almDiagnostics: !almDiagnostics } });
});

it('enforces the applied policy after CRDT establishes the first actual SDK connection', async () => {
    const { page, facade } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    await page.crdt.open({
        name: 'first',
        transport: 'ws',
        apiBaseUrl: CONFIG.rallar.apiBaseUrl,
        applicationId: 'app',
        workspaceId: 'default',
        rallar: { almDiagnostics: false },
        persist: false,
        tabSync: false
    });
    expect(facade.isConnected()).toBe(true);
    const defaults = vi.spyOn(facade, 'setDefaults');
    await expect(page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics: true } }))
        .rejects.toThrow(/close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
});

it.each([true, false])('binds actual SDK inbound recovery to the originating storage sink %s after defaults replacement', async (recording) => {
    const facade = createRallarFacade();
    onTestFinished(() => facade.disconnect());
    const callbacks: OnWebSocketMessageCallback[] = [];
    const register = JsonWebSocketClient.prototype.onWebSocketMessageDo;
    vi.spyOn(JsonWebSocketClient.prototype, 'onWebSocketMessageDo').mockImplementation(function (this: JsonWebSocketClient, id, callback) {
        if (id.endsWith('-inbox')) {
            callbacks.push(callback);
        }
        return register.call(this, id, callback);
    });
    const storage: ALStorageEvent[] = [];
    const invocations: number[] = [];
    facade.messages.channel({
        typeId: 'test.recovery',
        purpose: 'command',
        access: 'members',
        recovery: { onResyncRequired: (cursor) => invocations.push(cursor.observedSeq) }
    });
    facade.setDefaults({
        applicationId: 'app',
        diagnosticsPorts: {
            storage: (event) => {
                if (recording) {
                    storage.push(event);
                }
            }
        }
    });
    await facade.connect();
    storage.length = 0;
    facade.setDefaults({
        applicationId: 'app',
        diagnosticsPorts: {
            storage: (event) => {
                if (!recording) {
                    storage.push(event);
                }
            }
        }
    });
    const inbound = callbacks[0];
    if (!inbound) {
        throw new Error('Actual SDK did not register its WS inbox');
    }
    const message = newALUnicastMessage(
        'sender',
        { topicId: 'test.recovery', resourceId: crypto.randomUUID(), contextId: 'room' },
        'session',
        'test.recovery',
        {},
        { ttlMs: 60_000 }
    );
    const orderingKey = crypto.randomUUID();
    await inbound.onMessage({ ...message, ordering: { orderingKey, seq: 1 } }, new MessageEvent('message'));
    await inbound.onMessage({
        ...message,
        id: { ...message.id, msgId: crypto.randomUUID() },
        route: { ...message.route, resourceId: crypto.randomUUID() },
        ordering: { orderingKey, seq: 300 }
    }, new MessageEvent('message'));
    expect(invocations).toEqual([300]);
    const recoveryEvents = storage.filter((event) => event.kind === 'recovery-owner-invoked');
    expect(recoveryEvents).toHaveLength(recording ? 1 : 0);
});

it('rejects unverified SDK pending and active lifetimes before preparing a harness configuration', async () => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(connectionHttp, 'readApiConfig').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return CAPTURE_APPLICATION_API_CONFIG;
    });
    facade.configure({ apiBaseUrl: CONFIG.rallar.apiBaseUrl });
    const first = facade.connect();
    onTestFinished(async () => {
        release.resolve();
        await first;
        await page.close();
    });
    await entered.promise;
    const defaults = vi.spyOn(facade, 'setDefaults');
    await expect(page.connect(CONFIG)).rejects.toThrow(/unverified.*close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
    expect(appliedConfigurations(events)).toEqual([]);
    release.resolve();
    await first;
    await expect(page.connect(CONFIG)).rejects.toThrow(/unverified.*close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
    expect(appliedConfigurations(events)).toEqual([]);
});

it('attaches no-api CRDT to externally initialized SDK ports without claiming new ALM application', async () => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    facade.configure({ apiBaseUrl: CONFIG.rallar.apiBaseUrl });
    facade.setDefaults({ applicationId: 'app' });
    await facade.connect();
    const receipt = facade.rtcCapture();
    const defaults = vi.spyOn(facade, 'setDefaults');
    await page.crdt.open({ name: 'attach', transport: 'ws', applicationId: 'app', persist: false, tabSync: false });
    expect(defaults).not.toHaveBeenCalled();
    expect(facade.rtcCapture()).toBe(receipt);
    expect(appliedConfigurations(events)).toEqual([]);
    await expect(page.crdt.open({ name: 'explicit-unverified', transport: 'ws', rallar: { almDiagnostics: false } }))
        .rejects.toThrow(/unverified.*close.*reinitializ/i);
    expect(defaults).not.toHaveBeenCalled();
    expect(appliedConfigurations(events)).toEqual([]);
});

it('keeps changed HOST capture subject to actual SDK compatibility during matching ALM reuse', async () => {
    const { page, facade } = createCaptureApplicationRuntime();
    onTestFinished(async () => {
        await page.close();
    });
    await page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, rtc: { captureMode: 'off' } } });
    const defaults = vi.spyOn(facade, 'setDefaults');
    await expect(page.connect({ ...CONFIG, rallar: { ...CONFIG.rallar, rtc: { captureMode: 'native' } } }))
        .rejects.toMatchObject({ code: 'new-connection-required', requestedConfiguration: { mode: 'native', origin: 'host' } });
    expect(defaults).not.toHaveBeenCalled();
});

it.each([
    { almDiagnostics: true, operation: 'connect' },
    { almDiagnostics: false, operation: 'connect' },
    { almDiagnostics: true, operation: 'crdt' },
    { almDiagnostics: false, operation: 'crdt' }
])(
    'rejects stale $operation policy $almDiagnostics after external SDK replacement while preserving omitted attachment',
    async ({ almDiagnostics, operation }) => {
        const { page, facade, events } = createCaptureApplicationRuntime();
        onTestFinished(async () => {
            await page.close();
        });
        const config = { ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics } };
        await page.connect(config);
        const originalReceipt = facade.rtcCapture();
        await facade.disconnect();
        facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { outboundDiagnostics: () => {} } });
        await facade.connect();
        const replacementReceipt = facade.rtcCapture();
        expect(replacementReceipt).not.toBe(originalReceipt);
        const defaults = vi.spyOn(facade, 'setDefaults');
        const configure = vi.spyOn(facade, 'configure');
        const limits = vi.spyOn(BlackBoxRallarVolatileLimits.prototype, 'set');
        const successes = appliedConfigurations(events).length;
        const request = operation === 'connect'
            ? page.connect(config)
            : page.crdt.open({ name: 'stale-explicit', transport: 'ws', rallar: { almDiagnostics } });
        await expect(request).rejects.toThrow(/unverified.*close.*reinitializ/i);
        await page.crdt.open({ name: 'preserved-attachment', transport: 'ws', applicationId: 'app', persist: false, tabSync: false });
        expect(defaults).not.toHaveBeenCalled();
        expect(configure).not.toHaveBeenCalled();
        expect(limits).not.toHaveBeenCalled();
        expect(appliedConfigurations(events)).toHaveLength(successes);
        expect(facade.rtcCapture()).toBe(replacementReceipt);
    }
);

it.each([
    { almDiagnostics: true, operation: 'connect' },
    { almDiagnostics: false, operation: 'connect' },
    { almDiagnostics: true, operation: 'crdt' },
    { almDiagnostics: false, operation: 'crdt' }
])('rejects stale $operation policy $almDiagnostics while external SDK replacement is pending', async ({ almDiagnostics, operation }) => {
    const { page, facade, events } = createCaptureApplicationRuntime();
    const config = { ...CONFIG, rallar: { ...CONFIG.rallar, almDiagnostics } };
    await page.connect(config);
    await facade.disconnect();
    facade.setDefaults({ applicationId: 'app' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(connectionHttp, 'readApiConfig').mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return CAPTURE_APPLICATION_API_CONFIG;
    });
    const replacement = facade.connect();
    onTestFinished(async () => {
        release.resolve();
        await replacement;
        await page.close();
    });
    await entered.promise;
    const defaults = vi.spyOn(facade, 'setDefaults');
    const configure = vi.spyOn(facade, 'configure');
    const limits = vi.spyOn(BlackBoxRallarVolatileLimits.prototype, 'set');
    const successes = appliedConfigurations(events).length;
    const checked = Promise.withResolvers<void>();
    const readStatus = facade.status;
    const statusObserver = vi.spyOn(facade, 'status').mockImplementation(() => {
        expect(readStatus()).toBe('connecting');
        checked.resolve();
        return readStatus();
    });
    const request = operation === 'connect'
        ? page.connect(config)
        : page.crdt.open({
            name: 'pending-explicit',
            transport: 'ws',
            apiBaseUrl: CONFIG.rallar.apiBaseUrl,
            applicationId: 'app',
            workspaceId: 'default',
            rallar: { almDiagnostics }
        });
    const rejected = expect(request).rejects.toThrow(/unverified.*close.*reinitializ/i);
    await checked.promise;
    statusObserver.mockRestore();
    release.resolve();
    await rejected;
    await replacement;
    expect(defaults).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(limits).not.toHaveBeenCalled();
    expect(appliedConfigurations(events)).toHaveLength(successes);
});
