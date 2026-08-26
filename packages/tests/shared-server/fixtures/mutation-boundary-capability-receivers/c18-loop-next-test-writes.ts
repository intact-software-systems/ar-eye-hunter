import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateAfterForUpdateTurnsTestFalse(
    repository: ClientStateRepository
): void {
    let active = true;
    for (; active; active = false) {
        // The update makes the next test false.
    }
    void repository.insertPrincipal({} as never);
}

export function mutateAfterWhileBodyTurnsTestFalse(
    repository: ClientStateRepository
): void {
    let active = true;
    while (active) {
        active = false;
    }
    void repository.updatePrincipal({} as never, 0);
}

export function mutateAfterCandidateSpecificFalse(
    repository: ClientStateRepository,
    chooseExit: boolean
): void {
    let active = true;
    while (active) {
        if (chooseExit) {
            active = false;
        }
        else {
            active = true;
        }
    }
    void repository.deletePrincipal({} as never, 0);
}
