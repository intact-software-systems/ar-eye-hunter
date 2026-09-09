import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '../../queuebox/in-memory-queue-box.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '../ALStoreRetention.ts';
import { createALInboundAdmissionStore } from './al-inbound-admission-store.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from './al-inbound-message-runtime.ts';

export interface DefaultALInboundRuntimeResourceInput {
    readonly selfPeerId: string;
    readonly nowMs?: () => number;
    readonly random?: () => number;
    readonly newControlId?: () => string;
    readonly toInboxEntry: (msg: ALMessage) => ResourceEntry;
    readonly stores?: ALInboundRuntimeStores;
    readonly queueEngine?: InboxOutboxEngine;
}

export interface CreateDefaultALInboundMessageRuntimeDependencies
    extends
        DefaultALInboundRuntimeResourceInput,
        Omit<ALInboundMessageRuntime.Dependencies, keyof ALInboundMessageRuntime.Resources> {}

export function createDefaultALInboundMessageRuntime(
    dependencies: CreateDefaultALInboundMessageRuntimeDependencies
): ALInboundMessageRuntime {
    return new ALInboundMessageRuntime({
        ...dependencies,
        ...createDefaultALInboundRuntimeResources(dependencies)
    });
}

export function createDefaultALInboundRuntimeResources(
    input: DefaultALInboundRuntimeResourceInput
): ALInboundMessageRuntime.Resources {
    const nowMs = input.nowMs ?? Date.now;
    const newControlId = input.newControlId ?? crypto.randomUUID.bind(crypto);
    const stores = input.stores ?? createLocalALInboundRuntimeStores(nowMs);
    return {
        admissionStore: stores.admissionStore,
        workQueue: stores.workQueue,
        effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
        effectPreparation: {
            newControlId,
            selfPeerId: input.selfPeerId,
            createInboxEntry: input.toInboxEntry
        },
        clock: { nowMs },
        random: input.random ?? Math.random,
        queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
        ownsQueueEngine: input.queueEngine === undefined
    };
}

function createLocalALInboundRuntimeStores(nowMs: () => number): ALInboundRuntimeStores {
    const workQueue = new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()));
    return {
        admissionStore: createALInboundAdmissionStore({
            nowMs,
            namespace: 'al-inbound-runtime',
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(workQueue), nowMs),
            orderingTrackTtlMs: 5 * 60_000,
            supersedenceTrackTtlMs: 5 * 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue
    };
}
