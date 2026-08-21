import type { ClientStateRepository } from '@shared-server/mod.ts';

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
