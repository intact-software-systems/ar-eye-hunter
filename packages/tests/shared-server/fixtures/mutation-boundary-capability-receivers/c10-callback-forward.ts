import type { ClientStateRepository } from '@shared-server/mod.ts';

export function forwardKnownCallback(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const callback = makeCapturedWriter();
    forward(callback);
    void invoke({} as never);

    function makeCapturedWriter(): () => void {
        return () => {
            invoke = repository.insertPrincipal;
        };
    }
    function forward(value: () => void): void {
        invokeCallback(value);
    }
    function invokeCallback(value: () => void): void {
        value();
    }
}
