import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';

/** A backend that delegates every member to `backend`, except the members `replaced` names. */
export function createDelegatingALAdmissionWorkBackend(
    backend: ALAdmissionWorkBackend,
    replaced: Partial<Pick<ALAdmissionWorkBackend, 'read' | 'list' | 'write'>>
): ALAdmissionWorkBackend {
    return {
        workQueue: backend.workQueue,
        ready: () => backend.ready(),
        read: (key, decode) => backend.read(key, decode),
        list: (prefix, decode) => backend.list(prefix, decode),
        readWithin: (read) => backend.readWithin(read),
        write: (operation, executionExpiresAtMs) => backend.write(operation, executionExpiresAtMs),
        ...replaced
    };
}
