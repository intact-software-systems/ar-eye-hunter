import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function ignoreReturnedWriter(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const makeWriter = () => () => {
        invoke = repository.insertPrincipal;
    };
    const run = makeWriter();
    void run;
    void invoke({} as never);
}
