import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateBoundAliasChain(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const writer = () => {
    invoke = repository.insertPrincipal;
  };
  const dispatch = (callback: () => void) => callback();
  const bound = dispatch.bind(undefined, writer);
  const holder = { bound };
  const alias = holder.bound;
  alias.call(undefined);
  void invoke({} as never);
}
