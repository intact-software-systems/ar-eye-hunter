import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeComputedAliasedObject(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selector = {
        select(): void {
            invoke = repository.insertPrincipal;
        }
    };
    const alias = selector;
    const method: keyof typeof alias = 'select';
    alias[method]();
    void invoke({} as never);
}
