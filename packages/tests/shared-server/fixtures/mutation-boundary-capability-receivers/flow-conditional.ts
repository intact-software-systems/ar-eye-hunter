import type { ClientStateRepository } from '@shared-server/mod.ts';

export function conditionallyOverwriteBeforeCall(
  repository: ClientStateRepository,
  useRead: boolean,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
  if (useRead) invoke = repository.readSnapshot;
  void invoke({} as never);
}
