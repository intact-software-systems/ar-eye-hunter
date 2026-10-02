import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createDefaultIndexedDbALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    ALWAYS_OWNED_AL_DURABLE_WORK,
    type ALDurableWorkCommit,
    type ALDurableWorkOwnership
} from '@shared/alm/work/al-durable-work-ownership.ts';
import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkDiagnostics,
    type ALWorkReadinessProbeDiagnostics
} from '@shared/alm/work/al-work-handler.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';
import { createOutboundMessage } from '../outbound-runtime-test-fixture.ts';
import { createOutboundTestSession, createSessionOutboundTestRuntime } from '../session-outbound-test-runtime.ts';
import {
    collectProbe,
    fakePort,
    toFakeALWorkKey,
    toTestALWorkReadySelection
} from './al-work-test-entries.ts';

const WORK_TYPE = 'AL_TEST';
const COMMITTED_W1: ALWorkCommittedRows = { dueByMs: 1_000, writtenKeys: [toFakeALWorkKey('w-1')] };

afterEach(() => {
    vi.restoreAllMocks();
});

describe('ALWorkHandler under a session ownership', () => {
    it('registers no engine task, runs no batch and announces its commits while another runtime owns the work', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));

        await fixture.handler.ready();
        fixture.handler.committed(COMMITTED_W1);
        fixture.engine.wakeAfterExternalWrite();
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual([]);
        expect(fixture.probes).toEqual([]);
        expect(fixture.ownership.announced).toEqual([{ workType: WORK_TYPE, rows: COMMITTED_W1 }]);
    });

    it('registers its task and runs the bootstrap batch once when ownership turns true', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));
        await fixture.handler.ready();

        fixture.ownership.take();

        await vi.waitFor(() => expect(fixture.released).toEqual(['w-1:completed']));
        await fixture.handler.ready();
        expect(fixture.batchCount()).toBe(1);
        // The task now answers the engine's rounds, and an external write reaches its memory.
        await fixture.engine.executeOnce();
        fixture.engine.wakeAfterExternalWrite();
        await fixture.engine.executeOnce();
        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'external-wake']);
        // An owner runs its own commits and announces none.
        fixture.handler.committed(COMMITTED_W1);
        expect(fixture.ownership.announced).toEqual([]);
    });

    it('takes nothing over once disposed', async () => {
        const fixture = createOwnedHandler(createTestDurableWorkOwnership(false));

        fixture.handler.dispose();
        fixture.ownership.take();
        await fixture.ownership.owned.whenIdle();
        await fixture.engine.executeOnce();

        expect(fixture.released).toEqual([]);
        expect(fixture.probes).toEqual([]);
    });

    it('owns its work from construction under the always-owned value, as without one', async () => {
        const fixture = createOwnedHandler(ALWAYS_OWNED_AL_DURABLE_WORK);

        await fixture.engine.executeOnce();

        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory']);
    });
});

describe('two outbound runtimes of one session store', () => {
    it('admits a durable send where the work is not owned, and the owner sends it once on the announced commit', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));

        const admitted = await other.runtime.enqueueIfAbsent(createOutboundMessage('durable-1'));
        await other.engine.executeOnce();

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(other.sent).toEqual([]);
        expect(other.readDurableProbes()).toEqual([]);
        expect(other.ownership.announced).toEqual([
            {
                workType: toALOutboundWorkType(other.namespace),
                rows: { dueByMs: expect.any(Number), writtenKeys: [expect.any(String)] }
            }
        ]);

        // The session channel relays the announcement; here it is handed to the owner directly.
        other.ownership.announced.forEach((commit) => owner.ownership.deliver(commit));

        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-1']));
        expect(other.sent).toEqual([]);
    });

    it('takes over: registers the durable task, and its bootstrap sends the row and reports restored', async () => {
        const session = createOutboundTestSession();
        const previous = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        await previous.runtime.ready();
        previous.runtime.dispose();
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        await other.runtime.enqueueIfAbsent(createOutboundMessage('durable-1'));

        other.ownership.take();

        await vi.waitFor(() => expect(other.sent).toEqual(['durable-1']));
        await other.engine.executeOnce();
        expect(other.readDurableProbes()).not.toEqual([]);
        expect(session.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'storage-created' } },
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('sends a volatile message from its own memory lane while the durable work is owned elsewhere', async () => {
        const session = createOutboundTestSession();
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));

        await other.runtime.enqueueIfAbsent(createOutboundMessage('volatile-1'));

        await vi.waitFor(() => expect(other.sent).toEqual(['volatile-1']));
        expect(other.ownership.announced).toEqual([]);
    });
});

describe('two inbound runtimes of one session store', () => {
    it('admits a durable message where the work is not owned, and the owner delivers it on the announced commit', async () => {
        const namespace = `owned-inbound-${crypto.randomUUID()}`;
        const owner = createInboundSessionRuntime(namespace, createTestDurableWorkOwnership(true));
        const other = createInboundSessionRuntime(namespace, createTestDurableWorkOwnership(false));
        const message = createInboundTestMessage({ msgId: 'inbox-1', durability: 'local-inbox' });

        expect((await other.fixture.runtime.admitIncomingMessage(message, INBOUND_TEST_SOURCE)).right)
            .toEqual({ kind: 'admitted' });
        await other.fixture.queueEngine.executeOnce();

        expect(other.fixture.delivered).toEqual([]);
        expect(other.ownership.announced.map((commit) => commit.workType)).toEqual([
            toALInboundWorkType(other.fixture.stores.admissionStore.namespace, 'ws')
        ]);

        other.ownership.announced.forEach((commit) => owner.ownership.deliver(commit));

        await vi.waitFor(() => expect(owner.fixture.delivered).toEqual(['dispatched']));
        expect(other.fixture.delivered).toEqual([]);
    });
});

interface TestDurableWorkOwnership extends ALDurableWorkOwnership {
    readonly owned: ObservableLatestValue<boolean>;
    readonly announced: readonly ALDurableWorkCommit[];
    take(): void;
    /** Hands an announced commit to the lanes listening for its work type, as the session channel does for an owner. */
    deliver(commit: ALDurableWorkCommit): void;
}

function createTestDurableWorkOwnership(owned: boolean): TestDurableWorkOwnership {
    const value = new ObservableLatestValue<boolean>().set(owned);
    const announced: ALDurableWorkCommit[] = [];
    const listeners = new Map<string, Set<(rows: ALWorkCommittedRows) => void>>();
    return {
        owned: value,
        announced,
        isOwned: () => value.peek() === true,
        take: () => value.accept(true),
        announceCommit: (commit) => announced.push(commit),
        onForeignCommit: (workType, listener) => {
            const forType = listeners.get(workType) ?? new Set();
            listeners.set(workType, forType.add(listener));
            return () => forType.delete(listener);
        },
        deliver: (commit) => {
            if (value.peek() === true) {
                listeners.get(commit.workType)?.forEach((listener) => listener(commit.rows));
            }
        }
    };
}

function createOwnedHandler<TOwnership extends ALDurableWorkOwnership>(ownership: TOwnership) {
    const engine = new InboxOutboxEngine();
    const released: string[] = [];
    const diagnostics: ALWorkDiagnostics[] = [];
    const probes: ALWorkReadinessProbeDiagnostics[] = [];
    const handler = new ALWorkHandler({
        workerId: 'owned-worker',
        port: fakePort({
            claims: ['w-1'],
            onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`)
        }),
        queueEngine: engine,
        ownsQueueEngine: false,
        clock: { nowMs: () => 1_000 },
        pageSize: 16,
        readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
        readNextReadyAtMs: async () => undefined,
        selectReady: async (port, size) => toTestALWorkReadySelection(await port.claim({ maxCount: size, observedEntries: undefined })),
        runClaim: async () => ({ status: 'completed' }),
        diagnostics: (event) => {
            diagnostics.push(event);
            collectProbe(probes, event);
        },
        durableOwnership: { ownership, workType: WORK_TYPE }
    });
    onTestFinished(() => handler.dispose());
    return {
        handler,
        engine,
        ownership,
        released,
        probes,
        batchCount: () => diagnostics.filter((event) => event.kind === 'work-batch').length
    };
}

function createInboundSessionRuntime(namespace: string, ownership: TestDurableWorkOwnership) {
    const fixture = createInboundTestRuntime({
        stores: createDefaultIndexedDbALInboundRuntimeStores({ dbName: namespace, namespace }),
        carrier: 'ws',
        effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
        durableWorkOwnership: ownership
    });
    return { fixture, ownership };
}
