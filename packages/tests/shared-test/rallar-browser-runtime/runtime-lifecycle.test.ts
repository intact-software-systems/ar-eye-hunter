import type { RallarRealtimeSendResult } from '@shared-web/browser/rallar-realtime-facade.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { facade, loadRuntime, resetFacade, topics } from './browser-rallar-runtime-test-harness.ts';
import { createDeferred } from './browser-runtime-lifecycle-test-fixture.ts';
import { CrdtDocumentTestDouble } from './crdt-document-test-double.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('leaves rooms, logs out, and emits cleanup diagnostics on close', async () => {
    const runtime = await loadRuntime();

    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            leaveRoomOnClose: true,
            logoutOnClose: true
        }
    });
    const closeResult = await runtime.close();

    expect(facade.records.realtimeUnsubscribeCount).toBe(1);
    expect(facade.records.roomLeaves).toContainEqual([{
        roomId: 'room-1',
        clearCurrent: true,
        timeoutMs: undefined
    }]);
    expect(facade.records.logoutAttempts).toContainEqual([{ timeoutMs: undefined }]);
    expect(facade.records.disconnectCount).toBe(0);
    expect(closeResult).toMatchObject({
        status: 'closed',
        roomId: 'room-1',
        unsubscribed: 1,
        leftRoom: true,
        logout: true,
        disconnected: false,
        cleanupErrors: []
    });
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.cleanup.started',
        'rallar.browser.cleanup.unsubscribe_completed',
        'rallar.browser.cleanup.room_leave_completed',
        'rallar.browser.cleanup.logout_completed',
        'rallar.browser.closed'
    ]));
});

it('does not allow an in-flight connect to commit after close starts', async () => {
    const connection = createDeferred<object>();
    facade.behavior.connect.mockReturnValueOnce(connection.promise);
    const runtime = await loadRuntime();
    const connecting = runtime.connect({
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

    const closing = runtime.close();
    await Promise.resolve();
    expect(facade.records.disconnectCount).toBe(0);

    connection.resolve({});
    await expect(connecting).rejects.toThrow(
        'Connection was cancelled because the Rallar runtime closed.'
    );
    await closing;
    await expect(runtime.send({ data: 'after-close' })).rejects.toThrow(
        'Black-box Rallar runtime is not connected.'
    );
    expect(topics().lastIndexOf('rallar.browser.connect_completed')).toBeLessThan(0);
});

it('serializes concurrent connects that share a target but use different transports', async () => {
    const firstConnection = createDeferred<object>();
    facade.behavior.connect.mockReturnValueOnce(firstConnection.promise);
    const runtime = await loadRuntime();
    const baseConfig = {
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            typeId: 'chat.message',
            topicId: 'chat'
        }
    };

    const realtimeConnect = runtime.connect({
        ...baseConfig,
        rallar: {
            ...baseConfig.rallar,
            transport: 'realtime'
        }
    });
    await vi.waitFor(() => {
        expect(facade.records.connectionAttempts).toHaveLength(1);
    });
    const messagesConnect = runtime.connect({
        ...baseConfig,
        rallar: {
            ...baseConfig.rallar,
            transport: 'messages.rtc'
        }
    });
    expect(facade.records.connectionAttempts).toHaveLength(1);

    firstConnection.resolve({});
    await expect(realtimeConnect).resolves.toMatchObject({
        transport: 'realtime'
    });
    await expect(messagesConnect).resolves.toMatchObject({
        transport: 'messages.rtc'
    });

    expect(facade.records.connectionAttempts).toHaveLength(2);
    expect(facade.records.realtimeSubscriptions.length).toBe(1);
    expect(facade.records.rtcMessageSubscriptions.length).toBe(1);
    expect(facade.records.realtimeUnsubscribeCount).toBe(1);
});

it('serializes fresh authentication behind an in-flight connection', async () => {
    const firstConnection = createDeferred<object>();
    facade.behavior.connect.mockReturnValueOnce(firstConnection.promise);
    const runtime = await loadRuntime();
    const connecting = runtime.connect({
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

    const authenticating = runtime.authenticate({
        connection: 'bobHttp',
        actor: 'bob',
        rallar: {
            apiBaseUrl: 'https://other-api.example.test',
            username: 'bob',
            password: 'other-secret'
        }
    });
    expect(facade.records.configurationWrites.some(
        (input) => input.apiBaseUrl === 'https://other-api.example.test'
    )).toBe(false);

    firstConnection.resolve({});
    await connecting;
    await expect(authenticating).rejects.toThrow(
        'Fresh Rallar authentication requires closing the connected black-box runtime first.'
    );
    expect(facade.records.configurationWrites.some(
        (input) => input.apiBaseUrl === 'https://other-api.example.test'
    )).toBe(false);
});

it('deduplicates concurrent close cleanup', async () => {
    const runtime = await loadRuntime();
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            leaveRoomOnClose: true
        }
    });

    const [first, second] = await Promise.all([
        runtime.close(),
        runtime.close()
    ]);

    expect(first).toEqual(second);
    expect(facade.records.roomLeaves).toHaveLength(1);
    expect(facade.records.disconnectCount).toBe(1);
    expect(facade.records.realtimeUnsubscribeCount).toBe(1);
});

it('fences send completion after runtime close without serializing sends', async () => {
    const send = createDeferred<readonly RallarRealtimeSendResult[]>();
    facade.behavior.realtimeSend.mockReturnValueOnce(send.promise);
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
    const sending = runtime.send({ data: 'late-message' });
    const sendResult = expect(sending).rejects.toThrow(
        'Rallar send completed after the runtime closed.'
    );
    await vi.waitFor(() => {
        expect(facade.records.realtimeSends).toHaveLength(1);
    });

    await runtime.close();
    send.resolve([]);
    await sendResult;

    expect(topics()).not.toContain('rallar.browser.realtime.send_completed');
    expect(topics()).toContain('rallar.browser.realtime.send_failed');
});

it('rejects new resource effects while runtime close is in progress', async () => {
    const disconnection = createDeferred<void>();
    facade.behavior.disconnect.mockReturnValueOnce(disconnection.promise);
    facade.behavior.crdtOpen.mockResolvedValueOnce(
        new CrdtDocumentTestDouble({
            documentId: 'doc-during-close',
            initialValue: { title: 'initial' }
        })
    );
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
    facade.records.realtimeSends.length = 0;
    facade.records.crdtOpens.length = 0;
    facade.records.directorAppointments.length = 0;

    const closing = runtime.close();
    await vi.waitFor(() => {
        expect(facade.records.disconnectCount).toBe(1);
    });

    await expect(runtime.send({ data: 'during-close' })).rejects.toThrow(
        'Rallar send completed after the runtime closed.'
    );
    await expect(runtime.crdt.open({
        handle: 'during-close',
        name: 'during-close',
        transport: 'local-only'
    })).rejects.toThrow(
        'CRDT document open was cancelled because the Rallar runtime closed.'
    );
    await expect(runtime.director.appoint({
        roomId: 'room-1'
    })).rejects.toThrow(
        'Director operation completed after the runtime closed.'
    );

    expect(facade.records.realtimeSends).toHaveLength(0);
    expect(facade.records.crdtOpens).toHaveLength(0);
    expect(facade.records.directorAppointments).toHaveLength(0);

    disconnection.resolve();
    await closing;
});
