import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';

import type { WorkerHold } from '../../shared-server/integration/postgres/test-support/postgres-worker-hold.ts';
import { createDelegatingALAdmissionWorkBackend } from './create-delegating-al-admission-work-backend.ts';

/**
 * Holds the next `write` before it enters the backend: it arrives at the hold and starts only once the hold is
 * released, so a test can act while that write waits to begin. It reads and writes nothing until then, and the memory
 * backend serializes its writes, so every other write meanwhile commits first and this one then reads what they wrote.
 * Every later write runs at once. It is not a held commit: a write that read its rows and waits to commit cannot be
 * expressed in memory.
 */
export function holdALAdmissionWrite(backend: ALAdmissionWorkBackend, hold: WorkerHold): ALAdmissionWorkBackend {
    let held = false;
    return createDelegatingALAdmissionWorkBackend(backend, {
        write: async (operation, executionExpiresAtMs) => {
            if (!held) {
                held = true;
                await hold.arrive();
            }
            return await backend.write(operation, executionExpiresAtMs);
        }
    });
}
