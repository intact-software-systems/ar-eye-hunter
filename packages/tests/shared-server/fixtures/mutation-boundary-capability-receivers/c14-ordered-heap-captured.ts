import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeCapturedWriterBeforeLaterRebind(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['deletePrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const writers = {
        run: () => {
            invoke = repository.deletePrincipal;
        }
    };
    const readers = {
        run: () => {
            invoke = repository.readSnapshot;
        }
    };
    let selected = writers;
    const captured = () => selected.run();

    captured();
    selected = readers;
    void selected;
    void invoke({} as never);
}

export function invokeCapturedWriterAfterEarlierRebind(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const readers = {
        run: () => {
            invoke = repository.readSnapshot;
        }
    };
    const writers = {
        run: () => {
            invoke = repository.insertPrincipal;
        }
    };
    let selected = readers;
    const captured = () => selected.run();

    selected = writers;
    captured();
    void invoke({} as never);
}
