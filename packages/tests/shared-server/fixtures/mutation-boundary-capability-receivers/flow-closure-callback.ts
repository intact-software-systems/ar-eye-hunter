import type { ClientStateRepository } from '@shared-server/mod.ts';

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
