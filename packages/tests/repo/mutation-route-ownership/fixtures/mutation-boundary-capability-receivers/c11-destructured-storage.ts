import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeDestructuredStoredWriter(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const holder = {
        callbacks: [() => {
            invoke = repository.insertPrincipal;
        }]
    };
    const { callbacks: [run] } = holder;
    run();
    void invoke({} as never);
}
