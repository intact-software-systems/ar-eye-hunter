import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeObjectMethod(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const selection = {
        selectWrite(): void {
            invoke = repository.insertPrincipal;
        }
    };
    selection.selectWrite();
    void invoke({} as never);
}
