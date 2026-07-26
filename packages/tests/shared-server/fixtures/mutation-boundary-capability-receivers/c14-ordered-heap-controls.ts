import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const enabled: boolean;

export function ignoreReaderBeforeLaterWriterRebind(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const readers = {
    run: () => {
      invoke = repository.readSnapshot;
    },
  };
  const writers = {
    run: () => {
      invoke = repository.insertPrincipal;
    },
  };
  let selected = readers;

  selected.run();
  selected = writers;
  void selected;
  void invoke({} as never);
}

export function ignoreWriterOverwrittenOnEveryBranch(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const writer = {
    run: () => {
      invoke = repository.insertPrincipal;
    },
  };
  const firstReader = {
    run: () => {
      invoke = repository.readSnapshot;
    },
  };
  const secondReader = {
    run: () => {
      invoke = repository.readSnapshot;
    },
  };
  let selected = writer;

  if (enabled) selected = firstReader;
  else selected = secondReader;
  selected.run();
  void invoke({} as never);
}
