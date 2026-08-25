import type { RallarCrdtOperationBatch } from '@shared/crdt/crdt-types.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { facade, loadRuntime, resetFacade, topics } from './browser-rallar-runtime-test-harness.ts';
import { CrdtDocumentTestDouble } from './crdt-document-test-double.ts';

const TITLE_CHANGE_BATCH: RallarCrdtOperationBatch = {
    kind: 'batch',
    operations: [{
        kind: 'register.set',
        path: ['title'],
        value: 'changed',
        policy: 'lww'
    }]
};

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('opens a CRDT document with its configured initial value', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-1',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();

    const opened = await runtime.crdt.open({
        handle: 'doc',
        name: 'checklist',
        transport: 'local-only',
        initialValue: { title: 'initial' }
    });

    expect(facade.records.crdtOpens).toContainEqual([
        'checklist',
        expect.objectContaining({
            transport: 'local-only',
            initialValue: { title: 'initial' }
        })
    ]);
    expect(opened).toMatchObject({
        status: 'opened',
        handle: 'doc',
        value: { title: 'initial' }
    });
    expect(topics()).toContain('rallar.browser.crdt.opened');
});

it('applies, reads, and waits for CRDT document state', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-apply',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'doc',
        name: 'checklist',
        transport: 'local-only'
    });

    const applied = await runtime.crdt.apply({ handle: 'doc', batch: TITLE_CHANGE_BATCH });
    const read = await runtime.crdt.read({ handle: 'doc' });
    const wait = await runtime.crdt.wait({
        handle: 'doc',
        timeoutMs: 1_000,
        intervalMs: 10,
        stableForMs: 0,
        sync: false,
        conditions: [{
            source: 'value',
            path: 'applied.operations.0.kind',
            operator: 'equals',
            expected: 'register.set'
        }]
    });

    expect(applied).toMatchObject({ status: 'applied', updateId: 'update-apply-1' });
    expect(read).toMatchObject({
        status: 'read',
        value: { applied: TITLE_CHANGE_BATCH }
    });
    expect(wait).toMatchObject({ status: 'wait_matched', handle: 'doc', attempts: 1 });
    expect(document.records.applications).toEqual([{
        batch: TITLE_CHANGE_BATCH,
        status: 'completed',
        updateId: 'update-apply-1'
    }]);
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.crdt.applied',
        'rallar.browser.crdt.read',
        'rallar.browser.crdt.waiting',
        'rallar.browser.crdt.wait_matched'
    ]));
});

it('syncs a CRDT document and reports its health', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-sync',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'doc',
        name: 'checklist',
        transport: 'local-only'
    });

    const sync = await runtime.crdt.sync({
        handle: 'doc',
        transport: 'local-only',
        reason: 'unit-test'
    });
    const health = await runtime.crdt.health({ handle: 'doc' });

    expect(sync).toMatchObject({ status: 'synced', result: { status: 'synced' } });
    expect(health).toMatchObject({
        status: 'health',
        health: {
            replicaId: 'test-replica',
            pendingUpdateCount: 0
        }
    });
    expect(document.records.synchronizations).toEqual([{
        options: { transport: 'local-only', reason: 'unit-test' },
        status: 'completed',
        result: {
            status: 'synced',
            transport: 'local-only',
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0
        }
    }]);
});

it('undoes and redoes CRDT operation groups', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'doc-undo-redo',
        initialValue: { title: 'changed' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'doc',
        name: 'checklist',
        transport: 'local-only'
    });

    const undone = await runtime.crdt.undo({
        handle: 'doc',
        targetOperationGroupId: 'group-1',
        operations: [{
            kind: 'register.set',
            path: ['title'],
            value: 'initial',
            policy: 'lww'
        }]
    });
    const redone = await runtime.crdt.redo({
        handle: 'doc',
        targetOperationGroupId: 'group-1',
        operations: TITLE_CHANGE_BATCH.operations
    });

    expect(undone).toMatchObject({ status: 'undone', updateId: 'update-undo-1' });
    expect(redone).toMatchObject({
        status: 'redone',
        updateId: 'update-redo-1',
        value: {
            redone: {
                targetOperationGroupId: 'group-1',
                operations: TITLE_CHANGE_BATCH.operations
            }
        }
    });
});

it('closes and destroys CRDT handles through their owned lifecycle ports', async () => {
    const closingDocument = new CrdtDocumentTestDouble({
        documentId: 'doc-close',
        initialValue: { title: 'initial' }
    });
    const destroyingDocument = new CrdtDocumentTestDouble({
        documentId: 'doc-destroy',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen
        .mockResolvedValueOnce(closingDocument)
        .mockResolvedValueOnce(destroyingDocument);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'close-doc',
        name: 'checklist-close',
        transport: 'local-only'
    });
    await runtime.crdt.open({
        handle: 'destroy-doc',
        name: 'checklist-destroy',
        transport: 'local-only'
    });

    const closed = await runtime.crdt.close({ handle: 'close-doc' });
    const destroyed = await runtime.crdt.destroy({ handle: 'destroy-doc' });
    const runtimeHealth = await runtime.health();

    expect(closed).toMatchObject({ status: 'closed', handle: 'close-doc' });
    expect(destroyed).toMatchObject({ status: 'destroyed', handle: 'destroy-doc' });
    expect(closingDocument.records.close).toEqual({ invocations: 1, status: 'completed' });
    expect(destroyingDocument.records.destroy).toEqual({ invocations: 1, status: 'completed' });
    expect(runtimeHealth).toMatchObject({ crdt: { handles: [] } });
    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.crdt.closed',
        'rallar.browser.crdt.destroyed'
    ]));
});

it('times out CRDT waits with diagnostics', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'wait-timeout',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({
        handle: 'doc',
        name: 'wait-timeout',
        transport: 'local-only'
    });

    await expect(runtime.crdt.wait({
        handle: 'doc',
        timeoutMs: 5,
        intervalMs: 1,
        conditions: [{
            source: 'value',
            path: 'title',
            operator: 'equals',
            expected: 'never'
        }]
    })).rejects.toThrow('Timed out waiting for CRDT conditions');

    expect(topics()).toEqual(expect.arrayContaining([
        'rallar.browser.crdt.waiting',
        'rallar.browser.crdt.wait_failed'
    ]));
});
