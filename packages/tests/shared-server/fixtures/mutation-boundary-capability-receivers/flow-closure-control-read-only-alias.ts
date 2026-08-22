import type { ClientStateRepository } from '@shared-server/mod.ts';

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
