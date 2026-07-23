import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeArrayStoredWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const write = () => {
    invoke = repository.insertPrincipal;
  };
  const callbacks = [write];
  callbacks[0]();
  void invoke({} as never);
}
