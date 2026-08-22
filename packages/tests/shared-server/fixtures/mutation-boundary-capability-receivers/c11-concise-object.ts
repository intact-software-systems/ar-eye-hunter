import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeConciseReturnedObject(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const makeWriter = () => ({
        run(): void {
            invoke = repository.insertPrincipal;
        }
    });
    makeWriter().run();
    void invoke({} as never);
}
