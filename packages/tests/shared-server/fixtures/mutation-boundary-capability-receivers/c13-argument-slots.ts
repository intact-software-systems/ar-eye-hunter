import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const enabled: boolean;
declare const externalArguments: readonly (() => void)[];

export function mutateThroughDefaultSlots(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const install = (callback = () => {
    invoke = repository.insertPrincipal;
  }) => callback();

  install.apply(undefined, [,]);
  install(undefined);
  install.bind(undefined, undefined)();
  void invoke({} as never);
}

export function mutateThroughExactSpreadSlots(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const install = (_ignored: unknown, callback = () => undefined) => callback();
  const arguments_ = [, () => {
    invoke = repository.updatePrincipal;
  }] as const;

  install(...arguments_);
  void invoke({} as never);
}

export function mutateThroughApplySpreadSlots(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const install = (_ignored: unknown, callback = () => undefined) => callback();

  install.apply(undefined, [...[, () => {
    invoke = repository.deletePrincipal;
  }]]);
  void invoke({} as never);
}

export function mutateThroughChainedBoundApply(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const install = (
    first = () => {
      invoke = repository.insertPrincipal;
    },
    second = () => undefined,
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
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const install = (callback = () => undefined) => callback();
  const arguments_ = enabled
    ? [() => {
      invoke = repository.deletePrincipal;
    }]
    : externalArguments;

  install(...arguments_);
  void invoke({} as never);
}
