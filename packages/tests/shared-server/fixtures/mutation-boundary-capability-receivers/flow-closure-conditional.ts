import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeConditionalWriteHelper(
  repository: ClientStateRepository,
  enabled: boolean,
): void {
  const maybeSelectWrite = () => {
    if (enabled) invoke = repository.insertPrincipal;
  };
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  maybeSelectWrite();
  void invoke({} as never);
}
