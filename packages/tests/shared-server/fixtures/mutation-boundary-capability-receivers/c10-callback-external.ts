import type { ClientStateRepository } from '@shared-server/mod.ts';

export function passLocalWriteToExternal(
  repository: ClientStateRepository,
  external: (callback: () => void) => void,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const callback = () => {
    invoke = repository.insertPrincipal;
  };
  external(callback);
  void invoke({} as never);
}
