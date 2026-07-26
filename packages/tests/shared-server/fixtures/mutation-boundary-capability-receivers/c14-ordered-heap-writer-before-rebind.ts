import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeWriterBeforeLaterRebind(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const writers = {
    run: () => {
      invoke = repository.insertPrincipal;
    },
  };
  const readers = {
    run: () => {
      invoke = repository.readSnapshot;
    },
  };
  let selected = writers;

  selected.run();
  selected = readers;
  void selected;
  void invoke({} as never);
}
