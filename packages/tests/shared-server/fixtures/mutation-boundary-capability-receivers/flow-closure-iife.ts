import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeImmediately(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  (() => {
    invoke = repository.insertPrincipal;
  })();
  void invoke({} as never);
}
