import type { ClientStateRepository } from '@shared-server/mod.ts';

type ReadInput = Readonly<{ repository: ClientStateRepository }>;

export function readObjectCapability(input: ReadInput): void {
  void input.repository.readSnapshot({} as never);
  const { readSnapshot: read } = input.repository;
  void read({} as never);
}
