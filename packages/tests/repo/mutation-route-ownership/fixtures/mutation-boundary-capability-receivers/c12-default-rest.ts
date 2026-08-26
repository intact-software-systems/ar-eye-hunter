import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function mutateDefaultRest(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const writer = () => {
        invoke = repository.insertPrincipal;
    };
    const dispatch = (first = () => {}, ...rest: Array<() => void>) => {
        first();
        rest[0]?.();
    };
    dispatch(undefined, writer);
    void invoke({} as never);
}
