import '../../setup-browser-indexeddb.ts';

import { onTestFinished } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import type { ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createVolatileOutboundTestStores } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

/** One browser session's IndexedDB outbound store, which every runtime of the session opens, as tabs do. */
export interface OutboundTestSession {
    readonly dbName: string;
    readonly namespace: string;
    /** The storage events every runtime's store stated, in the order they were stated. */
    readonly storage: ALStorageEvent[];
}

export interface SessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership> {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly engine: InboxOutboxEngine;
    readonly ownership: TOwnership;
    /** The resource id of every message this runtime's carrier sent, in send order. */
    readonly sent: readonly string[];
    /** The admission namespace whose work type the session's runtimes share. */
    readonly namespace: string;
    readDurableProbes(): readonly ALOutboundRuntimeDiagnosticsEvent[];
}

export function createOutboundTestSession(): OutboundTestSession {
    return { dbName: `session-outbound-${crypto.randomUUID()}`, namespace: 'session-outbound', storage: [] };
}

/**
 * One runtime of the session on an engine of its own: a message whose resource id starts with
 * `durable` goes to the IndexedDB lane, any other to the runtime's memory lane.
 */
export function createSessionOutboundTestRuntime<TOwnership extends ALDurableWorkOwnership>(
    session: OutboundTestSession,
    ownership: TOwnership
): SessionOutboundTestRuntime<TOwnership> {
    const engine = new InboxOutboxEngine();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const sent: string[] = [];
    const stores = createDefaultIndexedDbALOutboundRuntimeStores<OutboundTestPayload>({
        dbName: session.dbName,
        namespace: session.namespace,
        decodePrepared: decodeOutboundTestPayload,
        storageHealth: new ALStorageHealth({ storeId: session.namespace, storage: (event) => session.storage.push(event) })
    });
    const runtime = createDefaultALOutboundMessageRuntime<OutboundTestPayload>({
        decodePreparedMessage: decodeOutboundTestPayload,
        queueEngine: engine,
        outbox: new InMemoryQueueBox(new Map()),
        stores,
        volatileStores: createVolatileOutboundTestStores(),
        durableWorkOwnership: ownership,
        carrier: 'ws',
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: msg.route.resourceId.startsWith('durable') ? 'durable' : 'volatile',
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        },
        diagnostics: (event) => diagnostics.push(event)
    });
    onTestFinished(() => runtime.dispose());
    return {
        runtime,
        engine,
        ownership,
        sent,
        namespace: stores.admissionStore.namespace,
        readDurableProbes: () => diagnostics.filter((event) => event.kind === 'readiness-probe' && event.lane === 'durable')
    };
}
