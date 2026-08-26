import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutatePostStoreDestructure(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callbacks = [() => {}];
    const alias = callbacks;
    store(() => {
        invoke = repository.insertPrincipal;
    });
    const [run] = callbacks;
    run();
    void invoke({} as never);

    function store(callback: () => void): void {
        alias[0] = callback;
    }
}
