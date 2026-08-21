import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const enabled: boolean;

export function mutateThroughReachableWriters(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selectWriter = () => {
        invoke = repository.insertPrincipal;
    };

    if (true) {
        selectWriter();
    }
    true && selectWriter();
    false || selectWriter();
    false ? undefined : selectWriter();
    if (enabled) {
        selectWriter();
    }
    void invoke({} as never);
}
