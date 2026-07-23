import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeCallFamily(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const write = () => {
    invoke = repository.insertPrincipal;
  };
  write.call(undefined);
  write.apply(undefined, []);
  write.bind(undefined)();
  void invoke({} as never);
}
