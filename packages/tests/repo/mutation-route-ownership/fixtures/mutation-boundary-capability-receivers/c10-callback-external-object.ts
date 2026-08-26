import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function passLocalWriteObjectToExternal(
    repository: ClientStateRepository,
    external: (value: { run(): void; }) => void
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    external({
        run(): void {
            invoke = repository.insertPrincipal;
        }
    });
    void invoke({} as never);
}
