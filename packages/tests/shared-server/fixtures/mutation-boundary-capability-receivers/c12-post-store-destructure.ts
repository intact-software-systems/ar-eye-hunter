import type { ClientStateRepository } from '@shared-server/mod.ts';

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
