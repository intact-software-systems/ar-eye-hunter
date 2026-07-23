import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreMutualReturnCycle(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const run = first({});
  run();
  void invoke({} as never);

  function first(value: unknown): () => void {
    return second({ first: first(value) });
  }
  function second(value: unknown): () => void {
    invoke = repository.readSnapshot;
    return first({ second: second(value) });
  }
}
