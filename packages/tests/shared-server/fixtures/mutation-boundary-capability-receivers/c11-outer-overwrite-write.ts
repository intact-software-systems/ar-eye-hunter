import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeLastOuterWriter(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    let stored = () => {
        invoke = repository.readSnapshot;
    };
    store(() => {
        invoke = repository.readSnapshot;
    });
    store(() => {
        invoke = repository.insertPrincipal;
    });
    stored();
    void invoke({} as never);

    function store(callback: () => void): void {
        stored = callback;
    }
}
