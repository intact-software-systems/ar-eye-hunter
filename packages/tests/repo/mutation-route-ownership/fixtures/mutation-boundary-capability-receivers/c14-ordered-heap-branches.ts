import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

declare const enabled: boolean;

export function invokeWriterAtBranchJoin(
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

    if (enabled) {
        selected = writers;
    }
    else {
        selected = readers;
    }
    selected.run();
    void invoke({} as never);
}

export function retainWriterAcrossPossibleLoop(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['readSnapshot']
        | ClientStateRepository['updatePrincipal'] = repository.readSnapshot;
    const readers = {
        run: () => {
            invoke = repository.readSnapshot;
        }
    };
    const writers = {
        run: () => {
            invoke = repository.updatePrincipal;
        }
    };
    let selected = writers;

    while (enabled) {
        selected = readers;
    }
    selected.run();
    void invoke({} as never);
}
