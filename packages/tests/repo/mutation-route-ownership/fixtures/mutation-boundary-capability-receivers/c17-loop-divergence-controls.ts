import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreAfterForContinue(repository: ClientStateRepository): void {
    for (;;) {
        continue;
    }
    void repository.insertPrincipal({} as never);
}

export function ignoreAfterEmptyFor(repository: ClientStateRepository): void {
    for (;;) {
        // Deliberately non-terminating.
    }
    // This is the analyzer boundary under test.
    void repository.updatePrincipal({} as never, 0);
}

export function ignoreAfterDoContinue(repository: ClientStateRepository): void {
    do {
        continue;
    }
    while (true);
    // This is the analyzer boundary under test.
    void repository.deletePrincipal({} as never, 0);
}

export function ignoreAfterWhile(repository: ClientStateRepository): void {
    while (true) {
        // Deliberately non-terminating.
    }
    // This is the analyzer boundary under test.
    void repository.insertPrincipal({} as never);
}

export function ignoreAfterNestedDivergence(repository: ClientStateRepository): void {
    while (true) {
        while (true) {
            // The inner loop prevents the outer body from continuing.
        }
        // This is the analyzer boundary under test.
        void repository.updatePrincipal({} as never, 0);
    }
}
