import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreOverwrittenOuterWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  let stored = () => {
    invoke = repository.readSnapshot;
  };
  store(() => {
    invoke = repository.insertPrincipal;
  });
  store(() => {
    invoke = repository.readSnapshot;
  });
  stored();
  void invoke({} as never);

  function store(callback: () => void): void {
    stored = callback;
  }
}
