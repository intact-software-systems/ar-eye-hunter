import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeAssignedObject(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    let selector: { select(): void; } | undefined = undefined;
    selector = {
        select(): void {
            invoke = repository.insertPrincipal;
        }
    };
    selector.select();
    void invoke({} as never);
}
