import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

declare function unknownArguments(): [callback: () => void];

export function mutatePossibleApply(
    repository: ClientStateRepository,
    enabled: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const writer = () => {
        invoke = repository.insertPrincipal;
    };
    const dispatch = (callback: () => void) => callback();
    const args: [callback: () => void] = enabled ? [writer] : unknownArguments();
    dispatch.apply(undefined, args);
    void invoke({} as never);
}
