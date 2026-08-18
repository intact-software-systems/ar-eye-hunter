import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeWriterAfterRebind(
  repository: ClientStateRepository,
): void {
  let invoke: ClientStateRepository['readSnapshot'] | ClientStateRepository['updatePrincipal'] =
    repository.readSnapshot;
  const readers = {
    run: () => {
      invoke = repository.readSnapshot;
    },
  };
  const writers = {
    run: () => {
      invoke = repository.updatePrincipal;
    },
  };
  let selected = readers;

  selected = writers;
  selected.run();
  void invoke({} as never);
}

export function invokeWriterAfterMultipleRebinds(
  repository: ClientStateRepository,
): void {
  let invoke: ClientStateRepository['readSnapshot'] | ClientStateRepository['deletePrincipal'] =
    repository.readSnapshot;
  const readers = {
    nested: {
      run: () => {
        invoke = repository.readSnapshot;
      },
    },
  };
  const writers = {
    nested: {
      run: () => {
        invoke = repository.deletePrincipal;
      },
    },
  };
  let selected = writers;

  selected = readers;
  selected = writers;
  let { nested } = selected;
  nested.run();
  nested = readers.nested;
  void nested;
  void invoke({} as never);
}
