import type { ClientStateRepository } from '@shared-server/mod.ts';

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
