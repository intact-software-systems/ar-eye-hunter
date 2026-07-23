type DomainRepository = Readonly<{
  insertPrincipal(input: unknown): void;
}>;

export function useOrdinaryDomainObject(
  input: Readonly<{ repository: DomainRepository }>,
): void {
  input.repository.insertPrincipal({ domain: true });
  const { insertPrincipal: writeDomainValue } = input.repository;
  writeDomainValue({ domain: true });
}
