import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateCallArguments(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const writer = () => {
    invoke = repository.insertPrincipal;
  };
  const dispatch = (callback: () => void) => callback();

  dispatch.call(undefined, writer);
  dispatch.apply(undefined, [writer]);
  dispatch.bind(undefined, writer)();
  void invoke({} as never);
}
