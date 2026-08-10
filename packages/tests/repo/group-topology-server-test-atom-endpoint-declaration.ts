export interface DeclaredTopologyTestAtomEndpoint {
  readonly sourcePath: string;
  readonly sourceCaseId: string;
  readonly sourceAtomId: string;
  readonly sourceFingerprint: string;
  readonly ownerPath: string;
  readonly ownerCaseId: string;
  readonly ownerAtomId: string;
  readonly ownerFingerprint: string;
  readonly disposition: 'declared-exact' | 'semantic' | 'shared-fixture';
  readonly declarationReason: string;
  readonly consolidationId: string | null;
  readonly consolidationReason: string | null;
}
