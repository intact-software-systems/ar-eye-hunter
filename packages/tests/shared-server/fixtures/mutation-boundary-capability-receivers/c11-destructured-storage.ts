import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeDestructuredStoredWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const holder = {
    callbacks: [() => {
      invoke = repository.insertPrincipal;
    }],
  };
  const { callbacks: [run] } = holder;
  run();
  void invoke({} as never);
}
