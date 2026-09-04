import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '../ALStoreRetention.ts';
import { createALInboundAdmissionStore } from './al-inbound-admission-store.ts';
import { ALInboundMessageRuntime, type ALInboundRuntimeStores } from './al-inbound-message-runtime.ts';

export interface DefaultALInboundRuntimeResourceInput {
    readonly selfPeerId: string;
    readonly inboxEntryTypeId: string;
    readonly stores?: ALInboundRuntimeStores;
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
    const admissionStore = input.stores?.admissionStore ?? createALInboundAdmissionStore({
        namespace: 'al-inbound-runtime',
        backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now),
        orderingTrackTtlMs: 5 * 60_000,
        supersedenceTrackTtlMs: 5 * 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return {
        admissionStore,
        selfPeerId: input.selfPeerId,
        inboxEntryTypeId: input.inboxEntryTypeId,
        effectWorkerId: `al-inbound:${crypto.randomUUID()}`,
        clock: { nowMs: () => Date.now() },
        scheduler: {
            schedule: (callback, delayMs) => {
                const timer = setTimeout(callback, delayMs);
                return () => clearTimeout(timer);
            }
        }
    };
}
