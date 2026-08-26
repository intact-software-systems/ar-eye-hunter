import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeWriterBeforeLaterRebind(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const writers = {
        run: () => {
            invoke = repository.insertPrincipal;
        }
    };
    const readers = {
        run: () => {
            invoke = repository.readSnapshot;
        }
    };
    let selected = writers;

    selected.run();
    selected = readers;
    void selected;
    void invoke({} as never);
}
