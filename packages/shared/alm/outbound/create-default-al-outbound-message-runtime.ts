import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '../../queuebox/in-memory-queue-box.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import { CircuitBreakerPolicy } from '../../resilience/circuit-breaker.ts';
import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '../al-runtime-stores.ts';
import type { ALOutboundPreparedMessageDecoder } from './al-outbound-admission-store.ts';
import { ALOutboundMessageRuntime, type ALOutboundRuntimeStores } from './al-outbound-message-runtime.ts';

const DEQUEUE_CIRCUIT_OPEN_MS = 10_000;
const DEQUEUE_MAX_CONSECUTIVE_FAILURES = 10;

/** The dequeue-admission resilience a composition without its own shared breaker gets. */
export function createDefaultALOutboundDequeueResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ milliseconds: DEQUEUE_CIRCUIT_OPEN_MS });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(
            DEQUEUE_MAX_CONSECUTIVE_FAILURES,
            duration,
            duration,
            duration
        ),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1
    });
}

export interface DefaultALOutboundRuntimeResourceInput<TPrepared> {
    readonly decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared>;
    readonly stores?: ALOutboundRuntimeStores<TPrepared>;
    readonly canonicalQueue?: QueueBoxResourceEntryRepository;
    readonly nowMs?: () => number;
    readonly random?: () => number;
    readonly queueEngine?: InboxOutboxEngine;
}

export interface CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
    extends
        Omit<DefaultALOutboundRuntimeResourceInput<TPrepared>, 'decodePrepared'>,
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
    readonly dequeue?: ALOutboundMessageRuntime.DequeueSource;
}

export function createDefaultALOutboundMessageRuntime<TPrepared>(
    dependencies: CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
): ALOutboundMessageRuntime<TPrepared> {
    return new ALOutboundMessageRuntime({
        ...dependencies,
        ...createDefaultALOutboundRuntimeResources({
            ...dependencies,
            decodePrepared: dependencies.decodePreparedMessage,
            canonicalQueue: dependencies.outbox
        }),
        dequeue: dependencies.dequeue ??
            { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
        planDequeuedMessage: dependencies.planDequeuedMessage ?? dependencies.planOutgoingMessage,
        afterDequeueAdmission: dependencies.afterDequeueAdmission,
        planRepairMessage: dependencies.planRepairMessage,
        diagnostics: dependencies.diagnostics
    });
}

export function createDefaultALOutboundRuntimeResources<TPrepared>(
    input: DefaultALOutboundRuntimeResourceInput<TPrepared>
): ALOutboundMessageRuntime.Resources<TPrepared> {
    if (!input.stores && input.canonicalQueue && !(input.canonicalQueue instanceof InMemoryQueueBox)) {
        throw new TypeError('Persistent outbound QueueBox requires its coordinated admission store');
    }
    const nowMs = input.nowMs ?? Date.now;
    const stores = input.stores ?? createDefaultInMemoryALOutboundRuntimeStores({
        nowMs,
        decodePrepared: input.decodePrepared,
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
        workQueue: stores.workQueue,
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
