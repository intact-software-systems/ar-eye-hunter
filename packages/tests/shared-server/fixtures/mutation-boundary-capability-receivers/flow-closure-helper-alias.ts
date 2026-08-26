import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeHelperAlias(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const select = selectWrite;
    select();
    void invoke({} as never);

    function selectWrite(): void {
        invoke = repository.insertPrincipal;
    }
}
