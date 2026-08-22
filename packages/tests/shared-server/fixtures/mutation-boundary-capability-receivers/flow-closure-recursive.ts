import type { ClientStateRepository } from '@shared-server/mod.ts';

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
