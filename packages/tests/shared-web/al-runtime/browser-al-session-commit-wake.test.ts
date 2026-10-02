import '../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import {
    BrowserALSessionChannel,
    toBrowserALSessionKey
} from '@shared-web/browser/al-runtime/browser-al-session-channel.ts';
import type { ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../../shared/alm/inbound-runtime-test-fixture.ts';
import { createOutboundMessage, drainEngine } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime
} from '../../shared/alm/session-outbound-test-runtime.ts';
import { FakeBroadcastChannel } from '../data/rallar-data-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app', workspaceId: 'workspace' };
const SESSION_ID = 'session-1';
/** Far inside the remembered answer's age bound, so only an announced commit can reach the owner. */
const DELIVERY_WAIT = { timeout: 1_000, interval: 5 };
/** A lock some other tab holds for the whole test: a connect requesting it waits. */
const HELD_ELSEWHERE: ALBrowserLocks = { request: async () => await new Promise<never>(() => {}) };

afterEach(() => {
    FakeBroadcastChannel.clear();
});

describe('browser AL session commit wake', () => {
    it('sends a durable message a waiting tab committed from the owner, without waiting for the age bound', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, openTabClaim('owner'));
        const waiting = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        await owner.runtime.ready();
        // The owner probes once and remembers that it has no work.
        await drainEngine(owner.engine);

        const admitted = await waiting.runtime.enqueueIfAbsent(createOutboundMessage('durable-foreign'));

        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: true });
        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-foreign']), DELIVERY_WAIT);
        expect(waiting.sent).toEqual([]);
    });

    // A second waiting tab hears the announcement too; it neither sends the row nor announces it again,
    // so one commit costs one message.
    it('leaves a foreign commit to the owner in every waiting tab', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, openTabClaim('owner'));
        const waiting = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        const bystander = createSessionOutboundTestRuntime(session, openTabClaim('waiting'));
        const wire = listenOnSessionChannel();

        await waiting.runtime.enqueueIfAbsent(createOutboundMessage('durable-once'));
        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-once']), DELIVERY_WAIT);
        await drainEngine(bystander.engine);

        expect(wire.map((message) => message.kind)).toEqual(['committed']);
        expect(bystander.sent).toEqual([]);
        expect(waiting.sent).toEqual([]);
    });

    // The owner's rotation has moved past the head of NEW, so the foreign row is found within this one
    // batch only because the owner's lane answers the announcement with a read from the head.
    it('delivers a durable inbound message a waiting tab admitted from the owner, reading from the head', async () => {
        const dbName = `commit-wake-inbound-${crypto.randomUUID()}`;
        const owner = createInboundTab(dbName, 'owner');
        const waiting = createInboundTab(dbName, 'waiting');
        await Promise.all([owner.runtime.ready(), waiting.runtime.ready()]);
        await drainEngine(owner.queueEngine);

        const admitted = await waiting.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'foreign-inbound', durability: 'local-inbox' }),
            INBOUND_TEST_SOURCE
        );

        expect(admitted.right).toEqual({ kind: 'admitted' });
        await vi.waitFor(() => expect(owner.delivered).toEqual(['dispatched']), DELIVERY_WAIT);
        expect(waiting.delivered).toEqual([]);
    });
});

type TabRole = 'owner' | 'waiting';

/** One connect's claim: the owner's is granted at once (no Locks API), a waiting one is never granted. */
function openTabClaim(role: TabRole): BrowserALDurableWorkClaim {
    const claim = new BrowserALDurableWorkClaim({
        scope: SCOPE,
        sessionId: SESSION_ID,
        locks: role === 'owner' ? undefined : HELD_ELSEWHERE,
        sessionChannel: new BrowserALSessionChannel({
            scope: SCOPE,
            sessionId: SESSION_ID,
            instanceId: crypto.randomUUID(),
            openPort: (name) => new FakeBroadcastChannel(name),
            applySettlement: () => {}
        })
    });
    claim.request();
    onTestFinished(() => claim.release());
    return claim;
}

function createInboundTab(dbName: string, role: TabRole): InboundTestRuntime {
    const { stores } = createInboundTestBackendStores({
        namespace: 'commit-wake',
        storage: 'indexeddb',
        observer: createPassThroughIndexedDbOperationObserver(),
        dbName
    });
    return createInboundTestRuntime({
        stores,
        carrier: 'ws',
        effectWorkerId: `al-inbound:${role}`,
        durableWorkOwnership: openTabClaim(role)
    });
}

/** Every message another object posts on the session's channel, as a further tab would hear it. */
function listenOnSessionChannel(): readonly BrowserALSessionChannel.Message[] {
    const heard: BrowserALSessionChannel.Message[] = [];
    const listener = new FakeBroadcastChannel(`rallar-alm:${toBrowserALSessionKey(SCOPE, SESSION_ID)}`);
    listener.onmessage = (event) => heard.push(event.data as BrowserALSessionChannel.Message);
    return heard;
}
