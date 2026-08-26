import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateSparseArray(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callbacks = [
        ,
        () => {
            invoke = repository.insertPrincipal;
        }
    ];
    const [, run] = callbacks;
    run!();
    void invoke({} as never);
}
