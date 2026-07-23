import type { ClientStateRepository } from '@shared-server/mod.ts';

export function captureCallBeforeReadOverwrite(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.insertPrincipal;
  [0].forEach(() => void invoke({} as never));
  invoke = repository.readSnapshot;
}
