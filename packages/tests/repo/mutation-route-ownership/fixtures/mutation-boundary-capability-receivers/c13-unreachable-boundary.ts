import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreUnreachableWriters(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selectWriter = () => {
        invoke = repository.insertPrincipal;
    };

    if (false) {
        selectWriter();
    }
    false && selectWriter();
    true || selectWriter();
    true ? undefined : selectWriter();
    if (true) {
        if (false) {
            selectWriter();
        }
    }
    void invoke({} as never);
}
