import type { ClientStateRepository } from '@shared-server/mod.ts';

export function callBeforeReadOverwrite(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
    void invoke({} as never);
    invoke = repository.readSnapshot;
    void invoke;
}
