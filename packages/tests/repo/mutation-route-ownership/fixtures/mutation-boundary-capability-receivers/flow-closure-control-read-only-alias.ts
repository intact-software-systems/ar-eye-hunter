import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeReadOnlyAlias(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
    const select = selectRead;
    select();
    void invoke({} as never);

    function selectRead(): void {
        invoke = repository.readSnapshot;
    }
}
