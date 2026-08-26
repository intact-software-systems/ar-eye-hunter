import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreNestedBreak(repository: ClientStateRepository): void {
    const stop: boolean = true;
    switch ('read') {
        case 'read': {
            if (stop) {
                break;
            }
        }
        /* falls through */
        default:
            void repository.insertPrincipal({} as never);
    }
}

export function ignoreNestedReturn(repository: ClientStateRepository): void {
    const stop: boolean = true;
    switch ('read') {
        case 'read': {
            if (stop) {
                return;
            }
        }
        /* falls through */
        default:
            void repository.updatePrincipal({} as never, 0);
    }
}

export function ignoreNestedThrow(repository: ClientStateRepository): void {
    const stop: boolean = true;
    switch ('read') {
        case 'read': {
            if (stop) {
                throw new Error('stop');
            }
        }
        /* falls through */
        default:
            void repository.deletePrincipal({} as never, 0);
    }
}
