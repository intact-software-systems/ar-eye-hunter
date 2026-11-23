import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';

import type { WorkerHold } from '../../../shared-server/integration/postgres/test-support/postgres-worker-hold.ts';

/**
 * The memory twin of `holdPostgresCommit`: the next `write` arrives at the hold and runs only once it is released, so a
 * test can act while that write is under way. The memory backend serializes its writes, so the write waits before it
 * reads anything: another instance's write meanwhile commits first, as it would ahead of a held PostgreSQL commit.
 * Every later write runs at once.
 */
export function holdALAdmissionWrite(backend: ALAdmissionWorkBackend, hold: WorkerHold): ALAdmissionWorkBackend {
    let held = false;
    return {
        workQueue: backend.workQueue,
        ready: () => backend.ready(),
        read: (key, decode) => backend.read(key, decode),
        list: (prefix, decode) => backend.list(prefix, decode),
        readWithin: (read) => backend.readWithin(read),
        write: async (operation, executionExpiresAtMs) => {
            if (!held) {
                held = true;
                await hold.arrive();
            }
            return await backend.write(operation, executionExpiresAtMs);
        }
    };
}
