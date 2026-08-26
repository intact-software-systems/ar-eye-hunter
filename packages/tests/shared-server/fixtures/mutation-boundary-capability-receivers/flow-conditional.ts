import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function conditionallyOverwriteBeforeCall(
    repository: ClientStateRepository,
    useRead: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
    if (useRead) {
        invoke = repository.readSnapshot;
    }
    void invoke({} as never);
}
