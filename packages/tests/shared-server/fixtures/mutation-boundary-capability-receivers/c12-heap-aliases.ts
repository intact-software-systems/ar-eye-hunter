import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateHeapAliases(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['updatePrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const writeInsert = () => {
    invoke = repository.insertPrincipal;
  };
  const writeUpdate = () => {
    invoke = repository.updatePrincipal;
  };

  const callbacks = [() => {}];
  const arrayAlias = callbacks;
  arrayAlias[0] = writeInsert;
  callbacks[0]();
  void invoke({} as never);

  const holder = { run: () => {} };
  const objectAlias = holder;
  holder.run = writeUpdate;
  objectAlias.run();
  void invoke({} as never, 0);
}
