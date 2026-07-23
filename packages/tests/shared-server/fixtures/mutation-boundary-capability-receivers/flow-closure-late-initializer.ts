import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeWriteHelperAfterInitialization(repository: ClientStateRepository): void {
  const selectWrite = () => {
    invoke = repository.insertPrincipal;
  };
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  selectWrite();
  void invoke({} as never);
}
