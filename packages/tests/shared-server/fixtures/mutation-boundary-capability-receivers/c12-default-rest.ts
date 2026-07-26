import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateDefaultRest(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const writer = () => {
    invoke = repository.insertPrincipal;
  };
  const dispatch = (first = () => {}, ...rest: Array<() => void>) => {
    first();
    rest[0]?.();
  };
  dispatch(undefined, writer);
  void invoke({} as never);
}
