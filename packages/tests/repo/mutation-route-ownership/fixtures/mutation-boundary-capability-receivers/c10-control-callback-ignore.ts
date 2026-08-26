import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreKnownCallback(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callback = () => {
        invoke = repository.insertPrincipal;
    };
    ignore(callback);
    void invoke({} as never);

    function ignore(_value: () => void): void {}
}
