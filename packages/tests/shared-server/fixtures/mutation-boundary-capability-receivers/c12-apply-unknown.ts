import type { ClientStateRepository } from '@shared-server/mod.ts';

declare function unknownArguments(): unknown[];

export function mutatePossibleApply(
  repository: ClientStateRepository,
  enabled: boolean,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const writer = () => {
    invoke = repository.insertPrincipal;
  };
  const dispatch = (callback: () => void) => callback();
  const args = enabled ? [writer] : unknownArguments();
  dispatch.apply(undefined, args);
  void invoke({} as never);
}
