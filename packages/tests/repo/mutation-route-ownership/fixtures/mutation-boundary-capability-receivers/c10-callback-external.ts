import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function passLocalWriteToExternal(
    repository: ClientStateRepository,
    external: (callback: () => void) => void
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callback = () => {
        invoke = repository.insertPrincipal;
    };
    external(callback);
    void invoke({} as never);
}
