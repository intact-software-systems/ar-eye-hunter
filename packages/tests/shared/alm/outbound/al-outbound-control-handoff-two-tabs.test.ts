import '../../../setup-browser-indexeddb.ts';

import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createOutboundTestRuntimeFor,
    runOutboundWorkTask
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const SENDER_PEER_ID = 'self';
/**
 * The controls one admission hands off, in hand-off order. Their work keys sort the other way, so a
 * batch that took two of them from one page would send them reversed.
 */
const CONTROL_SEQUENCE = ['control-d', 'control-c', 'control-b', 'control-a'] as const;
const DRAIN_PASS_LIMIT = 12;

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('sends each control two tabs hand off for one admission once, in hand-off order', async () => {
    const session = createTwoTabSession();
    const admittedBy: string[] = [];

    // Both tabs run the admission's send-control rows at once, as two owners whose leases overlap do.
    await Promise.all(session.tabs.map(async (tab) => {
        for (const msgId of CONTROL_SEQUENCE) {
            const [result] = await tab.runtime.enqueueAllIfAbsent([
                createControlMessage(msgId, session.nowMs())
            ]);
            expect(['admitted', 'pending', 'duplicate']).toContain(result!.verdict.kind);
            if (result!.verdict.kind === 'admitted') {
                admittedBy.push(msgId);
            }
        }
    }));
    await drainTabs(session.tabs);

    expect(admittedBy.toSorted()).toEqual([...CONTROL_SEQUENCE].toSorted());
    expect(session.sent.map((send) => send.msgId)).toEqual([...CONTROL_SEQUENCE]);
    expect(await readOwnerRows(session.tabs[0]!.stores)).toEqual({ canonical: 4, identity: 4 });
});

it('sends each control once, in hand-off order, when the tab that committed the first closes before sending it', async () => {
    const session = createTwoTabSession();
    const [first, second] = session.tabs as [TwoTabRuntime, TwoTabRuntime];
    const commitBundle = first.stores.admissionStore.commitBundle.bind(first.stores.admissionStore);
    vi.spyOn(first.stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
        const status = await commitBundle(bundle);
        // The tab closes the moment its commit lands, before its worker claims the send.
        first.runtime.dispose();
        return status;
    });

    expect(
        (await first.runtime.enqueueAllIfAbsent([
            createControlMessage('control-1', session.nowMs())
        ]))[0]!.verdict.kind
    )
        .toBe('admitted');
    // The other tab's inbound owner runs the same send-control row again, then the admission's next one.
    const retried = await second.runtime.enqueueAllIfAbsent([
        createControlMessage('control-1', session.nowMs())
    ]);
    expect(['pending', 'duplicate']).toContain(retried[0]!.verdict.kind);
    expect(
        (await second.runtime.enqueueAllIfAbsent([
            createControlMessage('control-2', session.nowMs())
        ]))[0]!.verdict.kind
    )
        .toBe('admitted');
    await drainTabs([second]);

    expect(session.sent.map((send) => `${send.tab}:${send.msgId}`)).toEqual([
        'second:control-1',
        'second:control-2'
    ]);
    expect(await readOwnerRows(second.stores)).toEqual({ canonical: 2, identity: 2 });
});

it('sends a control once when the tab that committed it closes inside its send and the other tab retries it', async () => {
    const session = createTwoTabSession({ crashFirstTabInsideTransport: true });
    const [first, second] = session.tabs as [TwoTabRuntime, TwoTabRuntime];

    expect(
        (await first.runtime.enqueueAllIfAbsent([
            createControlMessage('control-1', session.nowMs())
        ]))[0]!.verdict.kind
    )
        .toBe('admitted');
    await expect.poll(() => session.crashedInsideTransport).toBe(true);
    first.runtime.dispose();
    const retried = await second.runtime.enqueueAllIfAbsent([
        createControlMessage('control-1', session.nowMs())
    ]);
    expect(['pending', 'duplicate']).toContain(retried[0]!.verdict.kind);
    await drainTabs([second]);
    // The closed tab's lease still holds the send, on either commit path, until it lapses.
    expect(session.sent).toEqual([]);

    session.advanceMs(AL_OUTBOUND_WORK_LEASE_MS + 1);
    await drainTabs([second]);

    expect(session.sent.map((send) => `${send.tab}:${send.msgId}`)).toEqual(['second:control-1']);
    expect(await readOwnerRows(second.stores)).toEqual({ canonical: 1, identity: 1 });
});

interface TransportSend {
    readonly tab: 'first' | 'second';
    readonly msgId: string;
}

interface TwoTabRuntime {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
}

interface TwoTabSession {
    readonly tabs: readonly TwoTabRuntime[];
    readonly sent: readonly TransportSend[];
    readonly crashedInsideTransport: boolean;
    nowMs(): number;
    advanceMs(durationMs: number): void;
}

interface TwoTabSessionInput {
    /** The first tab's transport never returns, as a tab closed while a send is in flight. */
    readonly crashFirstTabInsideTransport: boolean;
}

/** Two tabs of one session: one IndexedDB database, one namespace and one sender, and the browser's one Web Lock. */
function createTwoTabSession(
    input: TwoTabSessionInput = { crashFirstTabInsideTransport: false }
): TwoTabSession {
    stubSharedWebLocks();
    let nowMs = Date.now();
    const sent: TransportSend[] = [];
    const dbName = `two-tab-controls-${crypto.randomUUID()}`;
    const session = {
        sent,
        crashedInsideTransport: false,
        nowMs: () => nowMs,
        advanceMs: (durationMs: number) => {
            nowMs += durationMs;
        },
        tabs: [] as TwoTabRuntime[]
    };
    for (const tab of ['first', 'second'] as const) {
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            namespace: 'two-tab-controls',
            nowMs: () => nowMs,
            decodePrepared: decodeOutboundTestPayload
        });
        const runtime = createOutboundTestRuntimeFor({
            stores,
            queueEngine: new InboxOutboxEngine(),
            decodePreparedMessage: decodeOutboundTestPayload,
            nowMs: () => nowMs,
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: true,
                preparedMessages: [{ transport: 'ws', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                if (tab === 'first' && input.crashFirstTabInsideTransport) {
                    session.crashedInsideTransport = true;
                    return await new Promise(() => {});
                }
                sent.push({ tab, msgId: prepared.msgId! });
                return { status: 'sent', submissionAttempted: true };
            }
        });
        session.tabs.push({ stores, runtime });
    }
    return session;
}

/** One exclusive lock per name, shared by both tabs, as the browser's Web Locks API is. */
function stubSharedWebLocks(): void {
    const tails = new Map<string, Promise<void>>();
    const request = async <T>(
        name: string,
        _options: Readonly<{ mode: 'exclusive'; }>,
        callback: () => Promise<T>
    ): Promise<T> => {
        const previous = tails.get(name) ?? Promise.resolve();
        const released = Promise.withResolvers<void>();
        tails.set(name, previous.then(() => released.promise));
        await previous;
        try {
            return await callback();
        }
        finally {
            released.resolve();
        }
    };
    vi.stubGlobal('navigator', { locks: { request } });
}

/** Runs both tabs' outbound batches until a pass sends nothing more. */
async function drainTabs(tabs: readonly TwoTabRuntime[]): Promise<void> {
    for (let pass = 0; pass < DRAIN_PASS_LIMIT; pass += 1) {
        await Promise.all(tabs.map((tab) => runOutboundWorkTask(tab.runtime)));
    }
}

function createControlMessage(msgId: string, nowMs: number): ALMessage {
    return {
        ...newALAckControlMessage(
            { v: 2, senderId: SENDER_PEER_ID, msgId, ts: nowMs },
            {
                ackedMsgId: 'inbound-admission',
                fromPeerId: SENDER_PEER_ID,
                toPeerId: 'peer',
                originPeerId: 'peer',
                logicalRecipientPeerId: SENDER_PEER_ID,
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: nowMs
            }
        ),
        constraints: { expiresAtMs: nowMs + 5 * 60_000 }
    };
}

interface OwnerRowCounts {
    readonly canonical: number;
    readonly identity: number;
}

async function readOwnerRows(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>
): Promise<OwnerRowCounts> {
    const rows = (await Promise.all(
        (await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key))
    ))
        .filter((entry): entry is ResourceEntry => entry !== undefined);
    return {
        canonical: rows.filter((entry) => entry.key.topicId === 'AL_OUTBOUND_MESSAGE').length,
        identity: rows.filter((entry) => entry.typeId === 'AL_OUTBOUND_IDENTITY').length
    };
}
