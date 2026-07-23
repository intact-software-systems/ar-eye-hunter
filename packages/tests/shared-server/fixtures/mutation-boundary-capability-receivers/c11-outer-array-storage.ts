import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeOuterArrayStoredWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const callbacks = [() => {
    invoke = repository.readSnapshot;
  }];
  store(() => {
    invoke = repository.insertPrincipal;
  });
  callbacks[0]();
  void invoke({} as never);

  function store(callback: () => void): void {
    callbacks[0] = callback;
  }
}
