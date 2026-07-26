import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreBoundWriter(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const dispatch = (callback: () => void) => callback();
  const bound = dispatch.bind(undefined, () => {
    invoke = repository.insertPrincipal;
  });
  void bound;
  void invoke({} as never);
}
