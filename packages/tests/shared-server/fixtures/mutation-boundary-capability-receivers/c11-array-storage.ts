import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeArrayStoredWriter(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const write = () => {
        invoke = repository.insertPrincipal;
    };
    const callbacks = [write];
    callbacks[0]();
    void invoke({} as never);
}
