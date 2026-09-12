import type {
    ALOutboundRuntimeStores,
    ALOutboundSettlementEmitter
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    toALOutboundWorkType
} from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundControlAdmission } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';

export interface TestALOutboundWorkPortInput<TPrepared> extends ALOutboundRuntimeStores<TPrepared> {
    readonly nowMs: () => number;
    /** Foreign queue types the owner also claims; empty for a scope that only runs its own work. */
    readonly dequeueTypes?: ReadonlySet<string>;
    /** The already-guarded settlement sink the runtime hands its control admission; a test may drop it. */
    readonly settlements?: ALOutboundSettlementEmitter;
}

/**
 * The outbound work port a test owns directly, with the lease, work types and deterministic jitter
 * the runtime composes. It lives here rather than in `packages/tests` because the root
 * `tsconfig.json` excludes that project, so a new required field on the port fails to compile here
 * instead.
 */
export function createTestALOutboundWorkPort<TPrepared>(
    input: TestALOutboundWorkPortInput<TPrepared>
): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: input.workQueue,
        workTypes: new Set([
            toALOutboundWorkType(input.admissionStore.namespace),
            ...input.dequeueTypes ?? []
        ]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: input.nowMs,
        random: () => 0.5
    });
}

export function createTestALOutboundControlAdmission<TPrepared>(
    input: TestALOutboundWorkPortInput<TPrepared>
): ALOutboundControlAdmission<TPrepared> {
    return input.admissionStore.createControlAdmission(
        createTestALOutboundWorkPort(input),
        { nowMs: input.nowMs },
        input.settlements ?? (() => {})
    );
}
