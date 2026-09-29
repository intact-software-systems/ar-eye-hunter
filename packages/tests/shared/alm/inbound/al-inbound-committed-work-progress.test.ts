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

it('takes a row committed to an idle owner in the batch its commit starts, and keeps the rotation where it stood', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'idle-head-read',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'idle-head-read'
    });
    // The delivery is the owned boundary for the first half; the order of page reads is the contract for
    // the second: the head read leaves no position behind, so the rotation resumes at RETRY.
    const scanned: EntityStatus[] = [];
    const readPage = fixture.stores.workQueue.readWorkPage.bind(fixture.stores.workQueue);
    vi.spyOn(fixture.stores.workQueue, 'readWorkPage').mockImplementation(async (request) => {
        scanned.push(request.status);
        return await readPage(request);
    });
    await fixture.runtime.ready();
    // The bootstrap batch read NEW from the start, so the rotation now stands at RETRY.
    expect(scanned).toEqual([EntityStatus.NEW]);

    await fixture.runtime.admitIncomingMessage(
        createInboundTestMessage({ msgId: 'successor' }),
        INBOUND_TEST_SOURCE
    );

    // The engine is never started here: the batch the commit ran read the head of NEW and took the row.
    await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
    expect(scanned).toEqual([EntityStatus.NEW, EntityStatus.NEW]);
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    await expect.poll(() => scanned.length).toBeGreaterThanOrEqual(4);
    // The head read did not store a position: the rotation resumes at RETRY.
    expect(scanned.slice(0, 4)).toEqual([
        EntityStatus.NEW,
        EntityStatus.NEW,
        EntityStatus.RETRY,
        EntityStatus.RESERVED
    ]);
});

it('takes a row committed during a rotation batch in the follow-up batch that batch runs', async () => {
    const held = Promise.withResolvers<void>();
    let heldEntered = false;
    const dispatchedIds: string[] = [];
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: 'busy-follow-up',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: 'busy-follow-up',
        gateDispatch: async (msg) => {
            dispatchedIds.push(msg.id.msgId);
            if (msg.id.msgId === 'rotation-held') {
                heldEntered = true;
                await held.promise;
            }
        }
    });
    onTestFinished(() => held.resolve());
    await fixture.runtime.ready();
    // Committed straight into the store, so no commit announces it: only the rotation finds it.
    const admissionStore = fixture.stores.admissionStore;
    const unannounced = createInboundTestMessage({ msgId: 'rotation-held' });
    expect(
        await admissionStore.commitBundle(
            await readInboundTestAdmission(admissionStore, unannounced)
        )
    ).toBe('committed');
    for (let round = 0; round < 8 && !heldEntered; round += 1) {
        await fixture.queueEngine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(heldEntered).toBe(true);

    expect(
        (await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'follow-up' }),
            INBOUND_TEST_SOURCE
        )).right
    )
        .toEqual({ kind: 'admitted' });
    held.resolve();

    // No engine round runs after the commit, so only a batch the handler runs itself can deliver
    // `follow-up`: the rotation-held batch had already moved the rotation past NEW, and the follow-up
    // batch its end starts takes the row through the head read the commit asked for.
    await expect.poll(() => dispatchedIds).toEqual(['rotation-held', 'follow-up']);
});

it('announces data replay work before releasing its admission claim', async () => {
    const stores = createInboundTestStores({ namespace: 'replay-notify', storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() });
    const admission = createInboundTestAdmission(stores);
    const message = {
        ...createInboundTestMessage({ msgId: 'replay-notify' }),
        constraints: { expiresAtMs: Date.now() + 60_000 }
    };
    expect(await admission.retainPending({ kind: 'admit-message', msg: message, source: INBOUND_TEST_SOURCE })).toEqual({ kind: 'pending-admission' });
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores,
        effectWorkerId: 'replay-notify'
    });
    const wake = vi.spyOn(fixture.queueEngine, 'wake');
    const release = stores.workQueue.releaseEntries.bind(stores.workQueue);
    let announcedBeforeRelease = false;
    vi.spyOn(stores.workQueue, 'releaseEntries').mockImplementation(async (releases) => {
        if (releases.some(({ entry }) => decodeALInboundWorkEntry(entry, stores.admissionStore.namespace).payload.kind === 'admit-message')) {
            announcedBeforeRelease = wake.mock.calls.length > 0;
        }
        return await release(releases);
    });
    await fixture.runtime.ready();
    expect(announcedBeforeRelease).toBe(true);
    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    await expect.poll(() => fixture.delivered).toEqual(['dispatched']);
});

it.each(['committed', 'retained', 'failed'] as const)('announces only durable work after %s data admission', async (outcome) => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
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
        carrier: 'ws',
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

it('delivers WS work committed while a live scan holds an empty NEW page', async () => {
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({ namespace: 'held-empty-new', storage: 'memory', observer: createPassThroughIndexedDbOperationObserver() }),
        effectWorkerId: 'held-empty-new'
    });
    await fixture.runtime.ready();

    const emptyNewObserved = Promise.withResolvers<void>();
    const releaseEmptyNew = Promise.withResolvers<void>();
    const scanned: EntityStatus[] = [];
    const readPage = fixture.stores.workQueue.readWorkPage.bind(fixture.stores.workQueue);
    let held = false;
    vi.spyOn(fixture.stores.workQueue, 'readWorkPage').mockImplementation(async (request) => {
        const page = await readPage(request);
        scanned.push(request.status);
        if (!held && request.status === EntityStatus.NEW && page.entries.length === 0) {
            held = true;
            emptyNewObserved.resolve();
            await releaseEmptyNew.promise;
        }
        return page;
    });

    fixture.queueEngine.start();
    onTestFinished(() => fixture.queueEngine.stop());
    try {
        await emptyNewObserved.promise;
        expect((await fixture.runtime.admitIncomingMessage(createInboundTestMessage({ msgId: 'held-new-successor' }), INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        expect(fixture.delivered).toEqual([]);
    }
    finally {
        releaseEmptyNew.resolve();
    }

    await expect.poll(() => fixture.delivered, { timeout: 500 }).toEqual(['dispatched']);
    expect(scanned.slice(0, 3)).toEqual([EntityStatus.RETRY, EntityStatus.RESERVED, EntityStatus.NEW]);
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
            carrier: 'ws',
            planIncomingMessage: planInboundTestMessage,
            canDispatchMessage: (msg) => !msg.id.msgId.startsWith('waiting-consumer-'),
            dispatchInboxEntry: async (entry) => {
                deliveries.set(decodePersistedALMessage(entry.resource).id.msgId, commits);
            },
            sendControlMessages: async () => {},
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
