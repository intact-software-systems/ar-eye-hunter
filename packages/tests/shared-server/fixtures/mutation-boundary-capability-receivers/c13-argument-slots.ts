import type { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';

declare const enabled: boolean;
declare const externalArguments: readonly (() => void)[];

export function mutateThroughDefaultSlots(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const install = (callback: () => void = () => {
        invoke = repository.insertPrincipal;
    }) => callback();

    install.apply(undefined, [,]);
    install(undefined);
    install.bind(undefined, undefined)();
    void invoke({} as never);
}

export function mutateThroughExactSpreadSlots(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['readSnapshot']
        | ClientStateRepository['updatePrincipal'] = repository.readSnapshot;
    const install = (_ignored: unknown, callback: () => void = () => undefined) => callback();
    const arguments_ = [, () => {
        invoke = repository.updatePrincipal;
    }] as const;

    install(...arguments_);
    void invoke({} as never);
}

export function mutateThroughApplySpreadSlots(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['deletePrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const install = (_ignored: unknown, callback: () => void = () => undefined) => callback();

    install.apply(undefined, [
        ...([, () => {
            invoke = repository.deletePrincipal;
        }] as const)
    ]);
    void invoke({} as never);
}

export function mutateThroughChainedBoundApply(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot']
        | ClientStateRepository['updatePrincipal'] = repository.readSnapshot;
    const install = (
        first: () => void = () => {
            invoke = repository.insertPrincipal;
        },
        second: () => void = () => undefined
    ) => {
        first();
        second();
    };
    const bound = install.bind(undefined, undefined);

    bound.apply(undefined, [() => {
        invoke = repository.updatePrincipal;
    }]);
    void invoke({} as never);
}

export function mutateThroughConservativeSpread(
    repository: ClientStateRepository
): void {
    let invoke:
        | ClientStateRepository['deletePrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const install = (callback: () => void = () => undefined) => callback();
    const arguments_ = enabled
        ? [() => {
            invoke = repository.deletePrincipal;
        }]
        : externalArguments;

    install(...arguments_);
    void invoke({} as never);
}
