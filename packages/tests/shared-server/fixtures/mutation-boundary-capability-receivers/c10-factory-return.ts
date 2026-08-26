import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeReturnedClosure(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const run = makeCapturedWriter();
    run();
    void invoke({} as never);

    function makeCapturedWriter(): () => void {
        return () => {
            invoke = repository.insertPrincipal;
        };
    }
}
