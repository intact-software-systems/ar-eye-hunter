import type { ClientStateRepository } from '@shared-server/mod.ts';

export function mutateAfterConditionalBreak(
  repository: ClientStateRepository,
  stop: boolean,
): void {
  for (;;) {
    if (stop) break;
  }
  void repository.deletePrincipal({} as never);
}
