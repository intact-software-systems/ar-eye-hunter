import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '../../queuebox/in-memory-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '../al-runtime-stores.ts';
import { ALOutboundMessageRuntime, type ALOutboundRuntimeStores } from './al-outbound-message-runtime.ts';

export interface DefaultALOutboundRuntimeResourceInput {
    readonly stores?: ALOutboundRuntimeStores;
    readonly canonicalQueue?: QueueBoxResourceEntryRepository;
    readonly nowMs?: () => number;
    readonly random?: () => number;
    readonly queueEngine?: InboxOutboxEngine;
}

export interface CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
    extends
        DefaultALOutboundRuntimeResourceInput,
        Pick<
            ALOutboundMessageRuntime.Dependencies<TPrepared>,
            | 'toOutboxEntry'
            | 'readMessageFromEntry'
            | 'planOutgoingMessage'
            | 'sendPreparedMessage'
            | 'decodePreparedMessage'
        >,
        Partial<
            Pick<
                ALOutboundMessageRuntime.Dependencies<TPrepared>,
                | 'planDequeuedMessage'
                | 'afterDequeueAdmission'
                | 'planRepairMessage'
                | 'diagnostics'
            >
        > {
    readonly outbox: QueueBoxResourceEntryRepository;
}

export function createDefaultALOutboundMessageRuntime<TPrepared>(
    dependencies: CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
): ALOutboundMessageRuntime<TPrepared> {
    return new ALOutboundMessageRuntime({
        ...dependencies,
        ...createDefaultALOutboundRuntimeResources({ ...dependencies, canonicalQueue: dependencies.outbox }),
        planDequeuedMessage: dependencies.planDequeuedMessage ?? dependencies.planOutgoingMessage,
        afterDequeueAdmission: dependencies.afterDequeueAdmission,
        planRepairMessage: dependencies.planRepairMessage,
        diagnostics: dependencies.diagnostics
    });
}

export function createDefaultALOutboundRuntimeResources(
    input: DefaultALOutboundRuntimeResourceInput = {}
): ALOutboundMessageRuntime.Resources {
    if (!input.stores && input.canonicalQueue && !(input.canonicalQueue instanceof InMemoryQueueBox)) {
        throw new TypeError('Persistent outbound QueueBox requires its coordinated admission store');
    }
    const nowMs = input.nowMs ?? Date.now;
    const stores = input.stores ?? createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        outboundBackend: new InMemoryAdmissionBackend(
            createInMemoryALAdmissionState(
                input.canonicalQueue instanceof InMemoryQueueBox
                    ? input.canonicalQueue
                    : new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(nowMs()))
            ),
            nowMs
        )
    });
    return {
        admissionStore: stores.admissionStore,
        effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
        clock: { nowMs },
        random: input.random ?? Math.random,
        queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
        ownsQueueEngine: input.queueEngine === undefined,
        browserLocks: typeof globalThis.navigator?.locks?.request === 'function'
            ? globalThis.navigator.locks
            : undefined
    };
}
