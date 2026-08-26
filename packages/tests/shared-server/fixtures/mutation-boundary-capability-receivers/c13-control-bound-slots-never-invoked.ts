import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreBoundSlotWriter(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const install = (callback = () => undefined) => callback();
    const bound = install.bind(undefined, () => {
        invoke = repository.insertPrincipal;
    });

    void bound;
    void invoke({} as never);
}
