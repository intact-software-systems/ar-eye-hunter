import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeKnownCallback(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callback = makeCapturedWriter();
    invokeCallback(callback);
    void invoke({} as never);

    function makeCapturedWriter(): () => void {
        return () => {
            invoke = repository.insertPrincipal;
        };
    }
    function invokeCallback(value: () => void): void {
        value();
    }
}
