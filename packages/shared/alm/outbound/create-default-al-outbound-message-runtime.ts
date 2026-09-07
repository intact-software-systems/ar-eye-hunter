import { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '../al-runtime-stores.ts';
import { ALOutboundMessageRuntime, type ALOutboundRuntimeStores } from './al-outbound-message-runtime.ts';

export interface DefaultALOutboundRuntimeResourceInput {
    readonly stores?: ALOutboundRuntimeStores;
    readonly nowMs?: () => number;
    readonly queueEngine?: InboxOutboxEngine;
}

export interface CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
    extends
        DefaultALOutboundRuntimeResourceInput,
        Pick<
            ALOutboundMessageRuntime.Dependencies<TPrepared>,
            | 'outbox'
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
                | 'beforeDequeueDispatch'
                | 'planRepairMessage'
                | 'onFallbackDequeue'
                | 'diagnostics'
            >
        > {}

export function createDefaultALOutboundMessageRuntime<TPrepared>(
    dependencies: CreateDefaultALOutboundMessageRuntimeDependencies<TPrepared>
): ALOutboundMessageRuntime<TPrepared> {
    return new ALOutboundMessageRuntime({
        ...dependencies,
        ...createDefaultALOutboundRuntimeResources(dependencies),
        planDequeuedMessage: dependencies.planDequeuedMessage ?? dependencies.planOutgoingMessage,
        beforeDequeueDispatch: dependencies.beforeDequeueDispatch,
        planRepairMessage: dependencies.planRepairMessage,
        onFallbackDequeue: dependencies.onFallbackDequeue,
        diagnostics: dependencies.diagnostics
    });
}

export function createDefaultALOutboundRuntimeResources(
    input: DefaultALOutboundRuntimeResourceInput = {}
): ALOutboundMessageRuntime.Resources {
    return {
        admissionStore: (input.stores ?? createDefaultInMemoryALOutboundRuntimeStores()).admissionStore,
        effectWorkerId: `al-outbound:${crypto.randomUUID()}`,
        clock: { nowMs: input.nowMs ?? (() => Date.now()) },
        queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
        ownsQueueEngine: input.queueEngine === undefined,
        browserLocks: typeof globalThis.navigator?.locks?.request === 'function'
            ? globalThis.navigator.locks
            : undefined
    };
}
