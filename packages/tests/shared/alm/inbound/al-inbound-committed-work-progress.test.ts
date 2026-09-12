import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { readInboundTestDispatchEffect } from '../create-inbound-test-dispatch.ts';
import {
    createInboundTestAdmission,
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    planInboundTestMessage,
    readInboundTestAdmission,
    setNextInboundCommitConflicted
} from '../inbound-runtime-test-fixture.ts';

afterEach(() => vi.restoreAllMocks());

it('announces data replay work before releasing its admission claim', async () => {
    const stores = createInboundTestStores({ namespace: 'replay-notify', storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() });
    const admission = createInboundTestAdmission(stores);
    const message = {
        ...createInboundTestMessage({ msgId: 'replay-notify' }),
        constraints: { expiresAtMs: Date.now() + 60_000 }
    };
    expect(await admission.retainPending({ kind: 'admit-message', msg: message, source: INBOUND_TEST_SOURCE })).toEqual({ kind: 'pending-admission' });
    const fixture = createInboundTestRuntime({ stores, effectWorkerId: 'replay-notify' });
    const wake = vi.spyOn(fixture.queueEngine, 'wake');
    const release = stores.workQueue.releaseEntries.bind(stores.workQueue);
    let announcedBeforeRelease = false;
    vi.spyOn(stores.workQueue, 'releaseEntries').mockImplementation(async (entries, outcome) => {
        if (entries.some((entry) => decodeALInboundWorkEntry(entry, stores.admissionStore.namespace).payload.kind === 'admit-message')) {
            announcedBeforeRelease = wake.mock.calls.length > 0;
        }
        return await release(entries, outcome);
    });
    await fixture.runtime.ready();
    expect(announcedBeforeRelease).toBe(true);
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
});

it.each(['committed', 'retained', 'failed'] as const)('announces only durable work after %s data admission', async (outcome) => {
    const fixture = createInboundTestRuntime({
        stores: createInboundTestStores({ namespace: `notify-${outcome}`, storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() }),
        effectWorkerId: `notify-${outcome}`
    });
    await fixture.runtime.ready();
    const wake = vi.spyOn(fixture.queueEngine, 'wake');
    if (outcome === 'retained') {
        setNextInboundCommitConflicted(fixture.stores.admissionStore);
    }
    if (outcome === 'failed') {
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockRejectedValueOnce(new Error('write aborted'));
        await expect(fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: outcome }), INBOUND_TEST_SOURCE)).rejects.toThrow('write aborted');
        expect(wake).not.toHaveBeenCalled();
        expect(await fixture.stores.workQueue.getAllKeys()).toEqual([]);
        return;
    }
    const acceptance = await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: outcome }), INBOUND_TEST_SOURCE);
    expect(acceptance.right).toEqual({ kind: outcome === 'retained' ? 'pending-admission' : 'admitted' });
    // Wake is the owned scheduler port: a durable write must request scheduling before returning.
    expect(wake).toHaveBeenCalled();
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
});

it('delivers work committed after an empty probe without a test wake', async () => {
    const fixture = createInboundTestRuntime({
        stores: createInboundTestStores({ namespace: 'empty-probe', storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() }),
        effectWorkerId: 'empty-probe'
    });
    await fixture.runtime.ready();
    const emptyRead = Promise.withResolvers<void>();
    const readPage = fixture.stores.workQueue.readWorkPage.bind(fixture.stores.workQueue);
    vi.spyOn(fixture.stores.workQueue, 'readWorkPage').mockImplementation(async (request) => {
        const page = await readPage(request);
        if (page.entries.length === 0) {
            emptyRead.resolve();
        }
        return page;
    });
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    await emptyRead.promise;
    expect((await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'after-empty' }), INBOUND_TEST_SOURCE)).right).toEqual({
        kind: 'admitted'
    });
    await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
});

it.each(['page-read', 'reservation'] as const)(
    'delivers later NEW, due RETRY and expired RESERVED work while bounded commits continue during %s',
    async (boundary) => {
        const stores = createInboundTestStores({
            namespace: 'committed-progress',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const waiting: ResourceEntry[] = [];
        for (let index = 0; index < 32; index += 1) {
            waiting.push(await seedDispatch(stores, `waiting-consumer-${index}`, EntityStatus.NEW));
        }
        const predecessor = createInboundTestMessage({ msgId: 'waiting-predecessor', seq: 2 });
        const predecessorAdmission = await readInboundTestAdmission(stores.admissionStore, predecessor);
        expect(await stores.admissionStore.commitBundle(predecessorAdmission)).toBe('committed');
        waiting.push(...predecessorAdmission.durableEffects.map((effect) => effect.entry));
        const eligible = [
            await seedDispatch(stores, 'eligible-new', EntityStatus.NEW),
            await seedDispatch(stores, 'eligible-retry', EntityStatus.RETRY),
            await seedDispatch(stores, 'eligible-reserved', EntityStatus.RESERVED)
        ];
        const deliveries = new Map<string, number>();
        let commits = 0;
        const commitLimit = 24;
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores,
            toInboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'inbox')
        });
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            planIncomingMessage: planInboundTestMessage,
            canDispatchMessage: (msg) => !msg.id.msgId.startsWith('waiting-consumer-'),
            dispatchInboxEntry: async (entry) => {
                deliveries.set(decodePersistedALMessage(entry.resource).id.msgId, commits);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        const readPage = stores.workQueue.readWorkPage.bind(stores.workQueue);
        const reserve = stores.workQueue.reserveEntries.bind(stores.workQueue);
        const produceCommit = async () => {
            if (commits < commitLimit) {
                commits += 1;
                const accepted = await runtime.admitIncomingMessage(
                    createInboundTestMessage({ msgId: `producer-${commits}` }),
                    INBOUND_TEST_SOURCE
                );
                expect(accepted.right).toEqual({ kind: 'admitted' });
            }
        };
        const producer = boundary === 'page-read'
            ? vi.spyOn(stores.workQueue, 'readWorkPage').mockImplementation(async (request) => {
                const page = await readPage(request);
                await produceCommit();
                return page;
            })
            : vi.spyOn(stores.workQueue, 'reserveEntries').mockImplementation(async (request) => {
                const reserved = await reserve(request);
                await produceCommit();
                return reserved;
            });
        try {
            await expect.poll(() => [...deliveries.keys()]).toEqual(expect.arrayContaining([
                'eligible-new',
                'eligible-retry',
                'eligible-reserved'
            ]));
            for (const id of ['eligible-new', 'eligible-retry', 'eligible-reserved']) {
                expect(deliveries.get(id), `${id} must progress before the commit producer ends`).toBeLessThan(commitLimit);
            }
            expect(commits).toBeGreaterThan(0);
        }
        finally {
            producer.mockRestore();
        }
        await expect.poll(() => [...deliveries.keys()].filter((id) => id.startsWith('producer-')).length).toBe(commits);
        for (const entry of eligible) {
            await expect.poll(async () => (await stores.workQueue.getItem(entry.key))?.status).toBe(EntityStatus.COMPLETED);
        }
        for (const entry of waiting) {
            expect(await stores.workQueue.getItem(entry.key)).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
        }
        expect(deliveries.has('waiting-predecessor')).toBe(false);
    }
);

async function seedDispatch(
    stores: ALInboundRuntimeStores,
    msgId: string,
    status: EntityStatus
): Promise<ResourceEntry> {
    const effect = await readInboundTestDispatchEffect(stores, createInboundTestMessage({ msgId }));
    const entry: ResourceEntry = {
        ...effect.entry,
        status,
        dequeueAudit: status === EntityStatus.RETRY
            ? { attempts: 1, nextTs: Temporal.Instant.fromEpochMilliseconds(Date.now() - 1_000) }
            : status === EntityStatus.RESERVED
            ? { attempts: 1, startTs: Temporal.Instant.fromEpochMilliseconds(Date.now() - 20_000) }
            : effect.entry.dequeueAudit
    };
    await stores.workQueue.enqueue(entry);
    return entry;
}
