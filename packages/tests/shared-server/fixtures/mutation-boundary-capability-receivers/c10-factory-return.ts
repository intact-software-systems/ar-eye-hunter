import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeReturnedClosure(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const run = makeCapturedWriter();
  run();
  void invoke({} as never);

  function makeCapturedWriter(): () => void {
    return () => {
      invoke = repository.insertPrincipal;
    };
  }
}
