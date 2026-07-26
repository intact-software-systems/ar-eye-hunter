import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateArrayFlowPattern(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const store = () => {
    [invoke] = [repository.insertPrincipal];
  };
  store();
  void invoke({} as never);
}
