import type { ClientStateRepository } from '@shared-server/mod.ts';

export function overwriteBeforeOnlyCall(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
  invoke = repository.readSnapshot;
  void invoke({} as never);
}
