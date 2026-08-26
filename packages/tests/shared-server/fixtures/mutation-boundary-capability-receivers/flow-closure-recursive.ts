import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeRecursiveWriteHelper(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    selectWrite(1);
    void invoke({} as never);

    function selectWrite(remaining: number): void {
        if (remaining > 0) {
            selectWrite(remaining - 1);
        }
        invoke = repository.insertPrincipal;
    }
}
