import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateForUpdateBeforeDivergence(repository: ClientStateRepository): void {
    for (;; repository.insertPrincipal({} as never)) {
        continue;
    }
}

export function mutateDoTestBeforeDivergence(repository: ClientStateRepository): void {
    do {
        continue;
    }
    while ((repository.updatePrincipal({} as never, 0), true));
}
