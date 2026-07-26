import type { ClientStateRepository } from '@shared-server/mod.ts';

export function ignoreNeverInvokedNestedWriter(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = root.callbacks;

  callbacks.write = () => {
    invoke = repository.insertPrincipal;
  };
  void callbacks.write;
  void invoke({} as never);
}

export function ignoreOverwrittenNestedWriter(
  repository: ClientStateRepository,
): void {
  let invoke = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = root.callbacks;

  callbacks.write = () => {
    invoke = repository.insertPrincipal;
  };
  root.callbacks.write = () => {
    invoke = repository.readSnapshot;
  };
  callbacks.write();
  void invoke({} as never);
}
