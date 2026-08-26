import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeConditionalStoredWriter(
    repository: ClientStateRepository,
    enabled: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const write = () => {
        invoke = repository.insertPrincipal;
    };
    const read = () => {
        invoke = repository.readSnapshot;
    };
    const callbacks = enabled ? [write] : [read];
    const [run] = callbacks;
    run();
    void invoke({} as never);
}
