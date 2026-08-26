import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeCyclicWritePath(
    repository: ClientStateRepository,
    recurse: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    first();
    void invoke({} as never);

    function first(): void {
        second();
    }
    function second(): void {
        const next = recurse ? first : selectWrite;
        next();
    }
    function selectWrite(): void {
        invoke = repository.insertPrincipal;
    }
}
