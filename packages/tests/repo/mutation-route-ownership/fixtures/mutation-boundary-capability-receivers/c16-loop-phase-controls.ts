import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreForUpdateAfterBreak(repository: ClientStateRepository): void {
    for (;; repository.insertPrincipal({} as never)) {
        break;
    }
}

export function ignoreLabeledForUpdateAfterBreak(
    repository: ClientStateRepository
): void {
    outer: for (;; repository.updatePrincipal({} as never, 0)) {
        {
            break outer;
        }
    }
}

export function ignoreDoTestAfterBreak(repository: ClientStateRepository): void {
    do {
        break;
    }
    while (repository.deletePrincipal({} as never, 0) as never);
}

export function ignoreForUpdateAfterReturn(repository: ClientStateRepository): void {
    for (;; repository.insertPrincipal({} as never)) {
        return;
    }
}

export function ignoreDoTestAfterThrow(repository: ClientStateRepository): void {
    do {
        throw new Error('stop');
    }
    while (repository.updatePrincipal({} as never, 0) as never);
}
