import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

const BOUNDARY_MODE: 'read' | 'write' = 'read';

export function ignoreCaseAfterBreak(
    repository: ClientStateRepository
): void {
    switch (BOUNDARY_MODE) {
        case 'read':
            void repository.readSnapshot;
            break;
        case 'write':
            void repository.insertPrincipal({} as never);
    }
}

export function ignoreCaseAfterReturn(
    repository: ClientStateRepository
): void {
    switch (BOUNDARY_MODE) {
        case 'read':
            return;
        case 'write':
            void repository.updatePrincipal({} as never, 1);
    }
}

export function ignoreCaseAfterThrow(
    repository: ClientStateRepository
): void {
    switch (BOUNDARY_MODE) {
        case 'read':
            throw new Error('stop');
        case 'write':
            void repository.deletePrincipal({} as never, 1);
    }
}

export function ignoreCaseAfterNestedBreak(
    repository: ClientStateRepository
): void {
    switch (BOUNDARY_MODE) {
        case 'read': {
            void repository.readSnapshot;
            break;
        }
        case 'write':
            void repository.insertPrincipal({} as never);
    }
}

export function ignoreDefaultBeforeExactMatch(
    repository: ClientStateRepository
): void {
    switch ('read') {
        default:
            void repository.insertPrincipal({} as never);
            break;
        case 'read':
            void repository.readSnapshot;
            break;
    }
}
