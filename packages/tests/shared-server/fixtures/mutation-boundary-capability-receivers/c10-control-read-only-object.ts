import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeReadOnlyObject(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
    const selector = {
        select(): void {
            invoke = repository.readSnapshot;
        }
    };
    const alias = selector;
    alias.select();
    void invoke({} as never);
}
