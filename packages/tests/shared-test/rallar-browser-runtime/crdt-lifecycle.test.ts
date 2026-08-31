import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { facade, loadRuntime, resetFacade, topics } from './browser-rallar-runtime-test-harness.ts';
import { CrdtDocumentTestDouble } from './crdt-document-test-double.ts';

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('revalidates queued live CRDT bootstrap before mutating the facade', async () => {
    const firstConnect = Promise.withResolvers<void>();
    facade.behavior.connect.mockReturnValueOnce(firstConnect.promise);
    facade.behavior.crdtOpen.mockResolvedValueOnce(
        new CrdtDocumentTestDouble({
            documentId: 'queued-live-doc',
            initialValue: { title: 'initial' }
        })
    );
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

    const opening = runtime.crdt.open({
        handle: 'queued-live-doc',
        name: 'queued-live-doc',
        transport: 'ws',
        apiBaseUrl: 'https://other-api.example.test',
        roomId: 'room-2',
        username: 'bob',
        password: 'other-secret'
    });
    const openingFailure = expect(opening).rejects.toThrow(
        'Connected Rallar identity, scope, or room changes require close first.'
    );

    firstConnect.resolve(undefined);
    await connecting;
    await openingFailure;
    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });
    expect(facade.records.crdtOpens).toHaveLength(0);
});

it('reserves CRDT handles before awaiting document creation', async () => {
    const openedDocument = Promise.withResolvers<CrdtDocumentTestDouble>();
    facade.behavior.crdtOpen.mockReturnValueOnce(openedDocument.promise);
    const runtime = await loadRuntime();
    const opening = runtime.crdt.open({
        handle: 'shared-doc',
        name: 'checklist',
        transport: 'local-only'
    });
    await vi.waitFor(() => {
        expect(facade.records.crdtOpens).toHaveLength(1);
    });

    await expect(runtime.crdt.open({
        handle: 'shared-doc',
        name: 'checklist',
        transport: 'local-only'
    })).rejects.toThrow('CRDT document handle is already open: shared-doc');
    expect(facade.records.crdtOpens).toHaveLength(1);

    openedDocument.resolve(
        new CrdtDocumentTestDouble({
            documentId: 'doc-shared',
            initialValue: { title: 'initial' }
        })
    );
    await opening;
});

it('waits for a late CRDT open and disposes the document during close', async () => {
    const openedDocument = Promise.withResolvers<CrdtDocumentTestDouble>();
    facade.behavior.crdtOpen.mockReturnValueOnce(openedDocument.promise);
    const runtime = await loadRuntime();
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-late',
        initialValue: { title: 'initial' }
    });
    const opening = runtime.crdt.open({
        handle: 'late-doc',
        name: 'checklist',
        transport: 'local-only'
    });
    const openingFailure = expect(opening).rejects.toThrow(
        'CRDT document open was cancelled because the Rallar runtime closed.'
    );
    await vi.waitFor(() => {
        expect(facade.records.crdtOpens).toHaveLength(1);
    });

    const closing = runtime.close();
    await Promise.resolve();
    expect(facade.records.disconnectCount).toBe(0);
    openedDocument.resolve(document);

    await openingFailure;
    await closing;
    expect(document.records.close).toEqual({ invocations: 1, status: 'completed' });
    await expect(runtime.crdt.read({ handle: 'late-doc' })).rejects.toThrow(
        'CRDT document handle is not open: late-doc'
    );
});

it('cancels a sleeping CRDT wait before close cleanup', async () => {
    vi.useFakeTimers();
    try {
        const document = new CrdtDocumentTestDouble({
            documentId: 'wait-during-close',
            initialValue: { title: 'initial' }
        });
        facade.behavior.crdtOpen.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({
            handle: 'wait-during-close',
            name: 'wait-during-close',
            transport: 'local-only'
        });
        const waiting = runtime.crdt.wait({
            handle: 'wait-during-close',
            timeoutMs: 60_000,
            intervalMs: 60_000,
            conditions: [{
                source: 'value',
                path: 'title',
                operator: 'equals',
                expected: 'never'
            }]
        });
        const waitFailure = expect(waiting).rejects.toThrow(
            'CRDT operation completed after the runtime closed.'
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(topics()).toContain('rallar.browser.crdt.waiting');

        const closing = runtime.close();
        await vi.advanceTimersByTimeAsync(0);
        expect(facade.records.disconnectCount).toBe(1);

        await vi.advanceTimersByTimeAsync(60_000);
        await waitFailure;
        await closing;
        expect(document.records.close).toEqual({ invocations: 1, status: 'completed' });
    }
    finally {
        vi.useRealTimers();
    }
});

it('rejects a queued CRDT wait before it starts polling after close', async () => {
    vi.useFakeTimers();
    try {
        const applyCompletion = Promise.withResolvers<void>();
        const document = new CrdtDocumentTestDouble({
            documentId: 'queued-wait-during-close',
            initialValue: { title: 'initial' },
            applyCompletion: applyCompletion.promise
        });
        facade.behavior.crdtOpen.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({
            handle: 'queued-wait-during-close',
            name: 'queued-wait-during-close',
            transport: 'local-only'
        });
        const applying = runtime.crdt.apply({
            handle: 'queued-wait-during-close',
            batch: {
                kind: 'batch',
                operations: [{
                    kind: 'register.set',
                    path: ['title'],
                    value: 'changed',
                    policy: 'lww'
                }]
            }
        });
        const applyFailure = expect(applying).rejects.toThrow(
            'CRDT operation completed after the runtime closed.'
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(document.records.applications).toMatchObject([{ status: 'in-flight' }]);

        const waiting = runtime.crdt.wait({
            handle: 'queued-wait-during-close',
            timeoutMs: 60_000,
            intervalMs: 60_000,
            conditions: [{
                source: 'value',
                path: 'title',
                operator: 'equals',
                expected: 'never'
            }]
        });
        const waitFailure = expect(waiting).rejects.toThrow(
            'CRDT operation completed after the runtime closed.'
        );
        const closing = runtime.close();

        applyCompletion.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        await applyFailure;
        await waitFailure;
        await closing;
    }
    finally {
        vi.useRealTimers();
    }
});

it('rejects a CRDT wait while close drains its in-flight sync', async () => {
    const syncCompletion = Promise.withResolvers<void>();
    const document = new CrdtDocumentTestDouble({
        documentId: 'sync-wait-during-close',
        initialValue: { title: 'initial' },
        syncCompletion: syncCompletion.promise
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'sync-wait-during-close',
        name: 'sync-wait-during-close',
        transport: 'local-only'
    });
    const waiting = runtime.crdt.wait({
        handle: 'sync-wait-during-close',
        timeoutMs: 60_000,
        intervalMs: 60_000,
        sync: { reason: 'wait-close-test' },
        conditions: [{
            source: 'value',
            path: 'title',
            operator: 'equals',
            expected: 'never'
        }]
    });
    await vi.waitFor(() => {
        expect(document.records.synchronizations).toMatchObject([{
            status: 'in-flight',
            options: { reason: 'wait-close-test' }
        }]);
    });

    const closing = runtime.close();
    await expect(waiting).rejects.toThrow(
        'CRDT operation completed after the runtime closed.'
    );
    expect(document.records.close).toEqual({ invocations: 0, status: 'not-started' });

    syncCompletion.resolve(undefined);
    await closing;
    expect(document.records.close).toEqual({ invocations: 1, status: 'completed' });
    expect(facade.records.disconnectCount).toBe(1);
});

it('does not close a CRDT document twice when explicit close races runtime close', async () => {
    const closeCompletion = Promise.withResolvers<void>();
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-closing',
        initialValue: { title: 'initial' },
        closeCompletion: closeCompletion.promise
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'closing-doc',
        name: 'checklist',
        transport: 'local-only'
    });

    const closingDocument = runtime.crdt.close({ handle: 'closing-doc' });
    await vi.waitFor(() => {
        expect(document.records.close).toEqual({ invocations: 1, status: 'in-flight' });
    });
    const closingRuntime = runtime.close();
    closeCompletion.resolve(undefined);

    await expect(closingDocument).rejects.toThrow(
        'CRDT operation completed after the runtime closed.'
    );
    await closingRuntime;
    expect(document.records.close).toEqual({ invocations: 1, status: 'completed' });
});

it('does not close a destroyed CRDT document when destroy races runtime close', async () => {
    const destroyCompletion = Promise.withResolvers<void>();
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-destroying',
        initialValue: { title: 'initial' },
        destroyCompletion: destroyCompletion.promise
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'destroying-doc',
        name: 'checklist',
        transport: 'local-only'
    });

    const destroyingDocument = runtime.crdt.destroy({ handle: 'destroying-doc' });
    await vi.waitFor(() => {
        expect(document.records.destroy).toEqual({ invocations: 1, status: 'in-flight' });
    });
    const closingRuntime = runtime.close();
    destroyCompletion.resolve(undefined);

    await expect(destroyingDocument).rejects.toThrow(
        'CRDT operation completed after the runtime closed.'
    );
    await closingRuntime;
    expect(document.records.destroy).toEqual({ invocations: 1, status: 'completed' });
    expect(document.records.close).toEqual({ invocations: 0, status: 'not-started' });
});

it('rejects a live CRDT target change before reconfiguring the connected facade', async () => {
    const runtime = await loadRuntime();
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            username: 'alice',
            password: 'secret'
        }
    });

    await expect(runtime.crdt.open({
        handle: 'other-live-doc',
        name: 'checklist',
        transport: 'ws',
        apiBaseUrl: 'https://other-api.example.test',
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        roomId: 'room-1',
        username: 'alice',
        password: 'secret'
    })).rejects.toThrow(
        'Connected Rallar identity, scope, or room changes require close first.'
    );
    expect(facade.records.configurationWrites).not.toContainEqual({
        apiBaseUrl: 'https://other-api.example.test'
    });
    expect(facade.records.crdtOpens).toHaveLength(0);
});
