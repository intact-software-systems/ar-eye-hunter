import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreStoredWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const callbacks = [() => {
    invoke = repository.insertPrincipal;
  }];
  void callbacks;
  void invoke({} as never);
}
