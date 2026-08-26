import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreNeverInvokedWriteHelper(repository: ClientStateRepository): void {
    const selectWrite = () => {
        invoke = repository.insertPrincipal;
    };
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    void selectWrite;
    void invoke({} as never);
}

export function invokeHoistedReadHelper(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
    selectRead();
    void invoke({} as never);

    function selectRead(): void {
        invoke = repository.readSnapshot;
    }
}
