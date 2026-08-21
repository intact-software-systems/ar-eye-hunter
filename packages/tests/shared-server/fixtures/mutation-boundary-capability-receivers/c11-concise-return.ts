import type { ClientStateRepository } from '@shared-server/mod.ts';

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
