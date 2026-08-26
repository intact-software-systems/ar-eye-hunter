import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function passWriteHelperAsCallback(repository: ClientStateRepository): void {
    const selectWrite = () => {
        invoke = repository.insertPrincipal;
    };
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    [0].forEach(selectWrite);
    void invoke({} as never);
}
