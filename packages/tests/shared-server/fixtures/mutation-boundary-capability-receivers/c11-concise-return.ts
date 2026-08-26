import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeConciseReturnedWriter(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const makeWriter = () => () => {
        invoke = repository.insertPrincipal;
    };
    const run = makeWriter();
    run();
    void invoke({} as never);
}
