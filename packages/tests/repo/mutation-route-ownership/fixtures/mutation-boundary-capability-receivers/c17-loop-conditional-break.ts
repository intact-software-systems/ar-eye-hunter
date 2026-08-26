import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateAfterConditionalBreak(
    repository: ClientStateRepository,
    stop: boolean
): void {
    for (;;) {
        if (stop) {
            break;
        }
    }
    void repository.deletePrincipal({} as never, 0);
}
