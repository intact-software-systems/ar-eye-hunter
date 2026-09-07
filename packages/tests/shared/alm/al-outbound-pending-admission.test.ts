import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import '../../setup-browser-indexeddb.ts';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it.each(['memory', 'indexeddb'] as const)('owns a real first-admission conflict through %s restart with one payload and the captured plan', async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const dbName = `outbound-pending-${crypto.randomUUID()}`;
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({ dbName: dbName, storeName: 'entries', nowMs: Date.now, newWriteToken: crypto.randomUUID.bind(crypto) });
    const options = { namespace: 'outbound-pending', backend, supersedenceTrackTtlMs: 60_000, retention: normalizeALRuntimeStoreRetention() };
    const store = createALOutboundAdmissionStore(options);
    const competitor = await computeOutboundTestAdmission(store, createOutboundMessage('competing-sender-version'));
    const commit = store.commitBundle.bind(store);
    let first = true;
    const heldStore = createFlakyOutboundAdmissionStore(store, {
        claimReadyEffects: async () => [],
        commitBundle: async (bundle, decode) => {
            if (first) {
                first = false;
                expect(await commit(competitor, decodeOutboundTestPayload)).toBe('committed');
            }
            return await commit(bundle, decode);
        }
    });
    const original = createOutboundMessage('pending-unique-payload', { ttlMs: 10_000 });
    const initial = createDefaultOutboundTestRuntime({
        stores: { admissionStore: heldStore },
        queueEngine: new InboxOutboxEngine(),
        planOutgoingMessage: (msg) => ({
            msg: { ...msg, constraints: { ...msg.constraints, expiresAtMs: Date.now() + 1_000 } },
            persist: false,
            preparedMessages: [{ peer: 'captured' }]
        }),
        sendPreparedMessage: async () => {
            throw new Error('No initial dispatch');
        }
    });
    const result = await initial.enqueueIfAbsent(original);
    expect(result.status).toBe('pending-admission');
    expect(await store.readSentMessage(original.id.msgId)).toBeUndefined();
    expect((await initial.enqueueIfAbsent(original)).status).toBe('pending-admission');
    expect(await store.readSentMessage(original.id.msgId)).toBeUndefined();
    initial.dispose();
    const rows = await Promise.all((await store.workQueue.getAllKeys()).map((key) => store.workQueue.getItem(key)));
    expect(rows.filter((row) => row?.resource.includes('pending-unique-payload'))).toHaveLength(1);
    expect(rows.filter((row) => row?.resource.includes('"kind":"admit-message"'))).toHaveLength(1);
    const restartedStore = createALOutboundAdmissionStore({
        ...options,
        backend: kind === 'memory'
            ? backend
            : new IndexedDbAdmissionBackend({ dbName: dbName, storeName: 'entries', nowMs: Date.now, newWriteToken: crypto.randomUUID.bind(crypto) })
    });
    const engine = new InboxOutboxEngine();
    const sent: string[] = [];
    const restarted = createDefaultOutboundTestRuntime({
        stores: { admissionStore: restartedStore },
        queueEngine: engine,
        planOutgoingMessage: (msg) => ({ msg, persist: true, preparedMessages: [{ peer: 'changed' }] }),
        sendPreparedMessage: async (prepared, _phase, lifecycle) => {
            sent.push(prepared.peer);
            expect(lifecycle.expiresAtMs).toBe(1_800_000_001_000);
            return { status: 'sent' };
        }
    });
    await restarted.ready();
    await expect.poll(async () => {
        await engine.executeOnce();
        return sent;
    }).toEqual(['captured']);
    const duplicate = await restarted.enqueueIfAbsent(original);
    expect(duplicate.status).toBe('duplicate');
    await engine.executeOnce();
    expect(sent).toEqual(['captured']);
    expect((await restartedStore.readSentMessage(original.id.msgId))?.msg.constraints?.expiresAtMs).toBe(1_800_000_001_000);
});
