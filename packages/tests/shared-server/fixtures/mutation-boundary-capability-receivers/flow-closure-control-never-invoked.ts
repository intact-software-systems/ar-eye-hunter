import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreNeverInvokedWrite(repository: ClientStateRepository): void {
    const selectWrite = () => {
        invoke = repository.insertPrincipal;
    };
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    void selectWrite;
    void invoke({} as never);
}
