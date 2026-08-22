import type { ClientStateRepository } from '@shared-server/mod.ts';

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
