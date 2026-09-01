import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi
} from 'vitest';

import { BlackBoxRallarCrdtResourceController } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-resource-controller.ts';
import { decodeBlackBoxRallarCrdtOpenInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts';
import {
    createRallarCrdtDocument,
    rallarCrdtAddCounterOperation,
    rallarCrdtBatch,
    type RallarCrdtDocumentRef,
    type RallarCrdtValidationOptions
} from '@shared/crdt/mod.ts';
import {
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';
import { CrdtDocumentTestDouble } from './crdt-document-test-double.ts';

beforeEach(resetFacade);
afterEach(() => vi.unstubAllGlobals());

const counterRef: RallarCrdtDocumentRef = {
    applicationId: 'app',
    workspaceId: 'workspace',
    scope: 'app',
    documentType: 'counter',
    documentId: 'counter'
};

it.each([undefined, {}, { maxOperationCount: 10 }])(
    'preserves the core schema fence with sparse validation: %j',
    (validation) => {
        const decoded = decodeBlackBoxRallarCrdtOpenInput({ name: 'counter', validation });
        const source = createRallarCrdtDocument({ ref: counterRef, schemaVersion: 2, replicaId: 'source' });
        const update = source.applyLocal(rallarCrdtBatch([rallarCrdtAddCounterOperation(['count'], 1)]));
        const snapshot = source.snapshot();
        const direct = createRallarCrdtDocument({ ref: counterRef, replicaId: 'direct', validation });
        const boundary = createRallarCrdtDocument({
            ref: counterRef,
            replicaId: 'boundary',
            validation: decoded.validation
        });

        expect(direct.apply(update).status).toBe('rejected');
        expect(boundary.apply(update).status).toBe('rejected');
        expect(() => direct.importSnapshot(snapshot)).toThrow('$.schemaVersion: Version is not supported: 2.');
        expect(() => boundary.importSnapshot(snapshot)).toThrow('$.schemaVersion: Version is not supported: 2.');
        expect(boundary.read()).toEqual({});

        const matching = createRallarCrdtDocument({ ref: counterRef, replicaId: 'matching' });
        const matchingUpdate = matching.applyLocal(rallarCrdtBatch([rallarCrdtAddCounterOperation(['count'], 1)]));
        expect(boundary.apply(matchingUpdate).status).toBe('applied');
        expect(boundary.read()).toEqual({ count: 1 });
    }
);

it('preserves the configured core operation version when validation omits its allowlist', () => {
    const decoded = decodeBlackBoxRallarCrdtOpenInput({ name: 'counter', validation: { maxOperationCount: 10 } });
    const source = createRallarCrdtDocument({ ref: counterRef, operationVersion: 2, replicaId: 'source' });
    const update = source.applyLocal(rallarCrdtBatch([rallarCrdtAddCounterOperation(['count'], 1)]));
    const direct = createRallarCrdtDocument({
        ref: counterRef,
        operationVersion: 2,
        replicaId: 'direct',
        validation: { maxOperationCount: 10 }
    });
    const boundary = createRallarCrdtDocument({
        ref: counterRef,
        operationVersion: 2,
        replicaId: 'boundary',
        validation: decoded.validation
    });

    expect(direct.apply(update).status).toBe('applied');
    expect(boundary.apply(update).status).toBe('applied');
    expect(boundary.read()).toEqual({ count: 1 });
});

it('preserves an explicit schema allowlist that expands the core default', () => {
    const decoded = decodeBlackBoxRallarCrdtOpenInput({
        name: 'counter',
        validation: { allowedSchemaVersions: [1, 2] }
    });
    const source = createRallarCrdtDocument({ ref: counterRef, schemaVersion: 2, replicaId: 'source' });
    const update = source.applyLocal(rallarCrdtBatch([rallarCrdtAddCounterOperation(['count'], 1)]));
    const boundary = createRallarCrdtDocument({ ref: counterRef, replicaId: 'boundary', validation: decoded.validation });

    expect(boundary.apply(update).status).toBe('applied');
    expect(boundary.read()).toEqual({ count: 1 });
});

const sparseValidationOptions: readonly RallarCrdtValidationOptions[] = [
    {},
    { maxPayloadBytes: 0 },
    { maxOperationCount: 0 },
    { maxParentCount: 0 },
    { maxPathDepth: 0 },
    { maxPathSegmentLength: 0 },
    { maxKeyLength: 0 },
    { maxElementIdLength: 0 },
    { maxBlockedUpdateCount: 0 },
    { allowedDocumentTypes: [] },
    { allowedOperationKinds: [] },
    { allowedSchemaVersions: [] },
    { allowedOperationVersions: [] },
    { pathSchema: { mode: 'strict', paths: [] } }
];

it.each(sparseValidationOptions)('preserves supplied validation fields without adding absent options: %j', (validation) => {
    const decoded = decodeBlackBoxRallarCrdtOpenInput({ name: 'counter', validation });
    expect(decoded.validation).toStrictEqual(validation);
});

it('releases a failed open reservation before its caller retries the handle', async () => {
    const controller = new BlackBoxRallarCrdtResourceController<object>({
        generation: () => 1,
        isCurrent: () => true
    });
    let rejected = false;
    try {
        await controller.open('retry', async () => {
            throw new Error('opening failed');
        });
    }
    catch {
        rejected = true;
        expect(controller.pending()).toHaveLength(0);
        const document = {};
        await expect(controller.open('retry', async () => document)).resolves.toBe(document);
    }
    expect(rejected).toBe(true);
});

it('rejects malformed CRDT operations before invoking a document', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'validated-operations',
        initialValue: { title: 'unchanged' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    await runtime.crdt.open({ handle: 'doc', name: 'validated-operations' });

    await expect(runtime.crdt.apply({
        handle: 'doc',
        batch: { kind: 'batch', operations: [{ kind: 'register.set', path: ['title'] }] }
    })).rejects.toThrow('valid operation batch');
    await expect(runtime.crdt.undo({
        handle: 'doc',
        targetOperationGroupId: 'group',
        operations: [{ kind: 'unrecognized' }]
    })).rejects.toThrow('valid operations');
    await expect(runtime.crdt.redo({
        handle: 'doc',
        targetOperationGroupId: 'group',
        operations: [{ kind: 'unrecognized' }]
    })).rejects.toThrow('valid operations');
    expect(document.records.applications).toEqual([]);
    expect(document.read()).toEqual({ title: 'unchanged' });
});

it.each([
    { policies: [{ documentType: 'checklist', rollout: 'unrecognized' }] },
    { validation: { maxOperationCount: 'many' } },
    { validation: { pathSchema: { mode: 'strict', paths: [{ path: ['title'], kind: 'unrecognized' }] } } },
    { encryption: { activeKeyId: 'key', keys: [{ keyId: 42 }] } },
    { scope: { kind: 'principal' } },
    { scope: { kind: 'room' } },
    { scope: { kind: 'custom' } },
    { initialValue: Number.NaN }
])('rejects malformed CRDT open options before opening a document: %j', async (options) => {
    const runtime = await loadRuntime();
    await expect(runtime.crdt.open({ name: 'invalid-options', ...options })).rejects.toThrow();
    expect(facade.records.crdtOpens).toEqual([]);
});

it('preserves nested live bootstrap identity and RTC lane defaults', async () => {
    facade.behavior.crdtOpen.mockResolvedValueOnce(
        new CrdtDocumentTestDouble({
            documentId: 'live-options',
            initialValue: { title: 'initial' }
        })
    );
    const runtime = await loadRuntime();
    const dataChannelLanes = [{
        id: 'authored-documents',
        label: 'CRDT data',
        binaryType: 'arraybuffer',
        init: { ordered: true, protocol: 'crdt' },
        flowControl: { maxQueueItems: 20 }
    }];
    await runtime.crdt.open({
        name: 'live-options',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'test-only-password',
            applicationId: 'app',
            workspaceId: 'workspace',
            roomId: 'room',
            crdtTransport: 'ws',
            laneId: 'authored-documents',
            openTimeoutMs: 500,
            dataChannelLanes
        }
    });
    expect(facade.records.configurationWrites).toContainEqual({ apiBaseUrl: 'https://api.example.test' });
    expect(facade.records.defaultWrites).toContainEqual({
        applicationId: 'app',
        workspaceId: 'workspace',
        room: {
            roomId: 'room',
            roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' }
        },
        realtime: { laneId: 'authored-documents', openTimeoutMs: 500 },
        rtc: { dataChannelLanes }
    });
    const defaults = facade.records.defaultWrites.at(-1);
    expect(defaults?.rtc?.dataChannelLanes?.[0]?.flowControl).toStrictEqual({ maxQueueItems: 20 });
    expect(facade.records.crdtOpens).toHaveLength(1);
});

it('requires a new full stable window after a remote document change breaks a match', async () => {
    vi.useFakeTimers();
    try {
        const document = new CrdtDocumentTestDouble({ documentId: 'stable-wait', initialValue: { title: 'initial' } });
        facade.behavior.crdtOpen.mockResolvedValueOnce(document);
        const runtime = await loadRuntime();
        await runtime.crdt.open({ handle: 'doc', name: 'stable-wait' });
        await document.applyLocal({ kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'title', value: 'ready' }] });
        let completed = false;
        const waiting = runtime.crdt.wait({
            handle: 'doc',
            timeoutMs: 100,
            intervalMs: 10,
            stableForMs: 30,
            conditions: [{ source: 'value', path: 'applied.operations.0.value', operator: 'equals', expected: 'ready' }]
        }).then((result) => {
            completed = true;
            return result;
        });
        await vi.advanceTimersByTimeAsync(0);
        await document.applyLocal({ kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'title', value: 'pending' }] });
        await vi.advanceTimersByTimeAsync(10);
        await document.applyLocal({ kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'title', value: 'ready' }] });
        await vi.advanceTimersByTimeAsync(30);
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(10);
        await expect(waiting).resolves.toMatchObject({ status: 'wait_matched', waitedMs: 50, stableForMs: 30, attempts: 6 });
        await runtime.close();
    }
    finally {
        vi.useRealTimers();
    }
});

it('preserves policy, validation, encryption and scoped open options after decoding', async () => {
    const document = new CrdtDocumentTestDouble({
        documentId: 'decoded-options',
        initialValue: { title: 'initial' }
    });
    facade.behavior.crdtOpen.mockResolvedValueOnce(document);
    const runtime = await loadRuntime();
    const policies = [{
        documentType: 'checklist',
        rollout: 'experimental-local',
        flags: { readOnly: true }
    }];
    const validation = {
        maxOperationCount: 8,
        allowedOperationKinds: ['register.set'],
        pathSchema: { mode: 'strict', paths: [{ path: ['title'], kind: 'register' }] }
    };
    const encryption = {
        activeKeyId: 'key',
        keys: [{ keyId: 'key', secret: 'test-only-key-material', rotationEpochMs: 12 }],
        visibleMetadataFields: ['document']
    };
    await runtime.crdt.open({
        name: 'decoded-options',
        roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        scope: { kind: 'room' },
        policies,
        validation,
        encryption,
        initialValue: { title: 'initial' }
    });
    expect(facade.records.crdtOpens).toEqual([[
        'decoded-options',
        expect.objectContaining({
            scope: { kind: 'room', roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } },
            policies,
            validation,
            encryption,
            initialValue: { title: 'initial' }
        })
    ]]);
});
