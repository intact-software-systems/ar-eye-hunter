import type { ClientStateRepository } from '@shared-server/mod.ts';

type NestedRepositoryInput = Readonly<{
  nested: Readonly<{ repository: ClientStateRepository }>;
}>;

export function mutateNestedDestructured(input: NestedRepositoryInput): void {
  const { nested: { repository: renamedRepository } } = input;
  void renamedRepository.insertPrincipal({} as never);
}
