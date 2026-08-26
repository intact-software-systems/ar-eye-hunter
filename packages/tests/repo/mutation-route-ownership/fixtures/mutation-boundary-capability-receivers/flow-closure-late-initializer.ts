import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeWriteHelperAfterInitialization(repository: ClientStateRepository): void {
    const selectWrite = () => {
        invoke = repository.insertPrincipal;
    };
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    selectWrite();
    void invoke({} as never);
}
