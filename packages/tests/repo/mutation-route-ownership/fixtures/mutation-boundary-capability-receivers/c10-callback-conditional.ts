import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

export function invokeConditionalCallback(
    repository: ClientStateRepository,
    enabled: boolean
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callback = makeCapturedWriter();
    invokeCallback(callback, enabled);
    void invoke({} as never);

    function makeCapturedWriter(): () => void {
        return () => {
            invoke = repository.insertPrincipal;
        };
    }
    function invokeCallback(value: () => void, shouldInvoke: boolean): void {
        const alias = value;
        const run = shouldInvoke ? alias : () => {};
        run();
    }
}
