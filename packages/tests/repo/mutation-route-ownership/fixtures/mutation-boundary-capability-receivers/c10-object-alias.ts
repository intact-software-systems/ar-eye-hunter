import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeAliasedObject(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selector = {
        select(): void {
            invoke = repository.insertPrincipal;
        }
    };
    const alias = selector;
    alias.select();
    void invoke({} as never);
}
