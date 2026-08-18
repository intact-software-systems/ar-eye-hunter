import type { ClientStateRepository } from '@shared-server/mod.ts';

declare const enabled: boolean;
declare const dynamicMember: string;

export function mutateThroughRootWrite(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = root.callbacks;
  const select = () => {
    root.callbacks.write = () => {
      invoke = repository.insertPrincipal;
    };
  };

  select();
  callbacks.write();
  void invoke({} as never);
}

export function mutateThroughAliasWrite(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['readSnapshot']
    | ClientStateRepository['updatePrincipal'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = root.callbacks;
  const select = () => {
    callbacks.write = () => {
      invoke = repository.updatePrincipal;
    };
  };

  select();
  root.callbacks.write();
  void invoke({} as never);
}

export function mutateThroughNestedAlias(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['deletePrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const root = { callbacks: { nested: { write: () => undefined } } };
  const nested = root.callbacks.nested;
  const select = () => {
    nested.write = () => {
      invoke = repository.deletePrincipal;
    };
  };

  select();
  root.callbacks.nested.write();
  void invoke({} as never);
}

export function mutateThroughDestructuredAlias(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const { callbacks } = root;
  const select = () => {
    root.callbacks.write = () => {
      invoke = repository.insertPrincipal;
    };
  };

  select();
  callbacks.write();
  void invoke({} as never);
}

export function mutateThroughComputedAlias(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['readSnapshot']
    | ClientStateRepository['updatePrincipal'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const member = 'callbacks';
  const callbacks = root[member];
  const select = () => {
    callbacks.write = () => {
      invoke = repository.updatePrincipal;
    };
  };

  select();
  root.callbacks.write();
  void invoke({} as never);
}

export function mutateThroughConditionalAlias(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['deletePrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = enabled ? root.callbacks : root.callbacks;
  const select = () => {
    callbacks.write = () => {
      invoke = repository.deletePrincipal;
    };
  };

  select();
  root.callbacks.write();
  void invoke({} as never);
}

export function mutateThroughUnknownMember(
  repository: ClientStateRepository,
): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  const root = { callbacks: { write: () => undefined } };
  const callbacks = root.callbacks;
  const select = () => {
    callbacks[dynamicMember as 'write'] = () => {
      invoke = repository.insertPrincipal;
    };
  };

  select();
  callbacks[dynamicMember as 'write']();
  void invoke({} as never);
}
