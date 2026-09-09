import type { ALInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { AL_INBOUND_WORK_LEASE_MS, toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundControlAdmission } from '@shared/alm/inbound/control/al-inbound-control-admission.ts';
import { createALWorkQueuePort, type ALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';

export interface TestALInboundWorkPortInput extends ALInboundRuntimeStores {
    readonly nowMs: () => number;
}

export interface TestALInboundControlAdmissionInput extends TestALInboundWorkPortInput {
    readonly newControlId: () => string;
}

/**
 * The inbound work port a test owns directly, with the lease, work type and deterministic jitter the
 * runtime composes. It lives here rather than in `packages/tests` because the root `tsconfig.json`
 * excludes that project, so a new required field on the port fails to compile here instead.
 */
export function createTestALInboundWorkPort(input: TestALInboundWorkPortInput): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: input.workQueue,
        workTypes: new Set([toALInboundWorkType(input.admissionStore.namespace)]),
        leaseMs: AL_INBOUND_WORK_LEASE_MS,
        nowMs: input.nowMs,
        random: () => 0.5
    });
}

export function createTestALInboundControlAdmission(
    input: TestALInboundControlAdmissionInput
): ALInboundControlAdmission {
    return new ALInboundControlAdmission({
        admissionStore: input.admissionStore,
        port: createTestALInboundWorkPort(input),
        clock: { nowMs: input.nowMs },
        newControlId: input.newControlId,
        retention: input.admissionStore.retention
    });
}
