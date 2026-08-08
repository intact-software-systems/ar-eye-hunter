import type { RallarOntologyTermBase } from './rallar-ontology-contracts.ts';

export interface RallarDomainOntologyTerm extends RallarOntologyTermBase {
  readonly kind: 'domain';
  readonly domainKind:
    | 'scope'
    | 'identity'
    | 'entity'
    | 'value-object'
    | 'projection'
    | 'snapshot'
    | 'event'
    | 'proposal';
  readonly authority: 'authoritative' | 'derived' | 'projection' | 'proposal';
  readonly identityFields: readonly string[];
}
