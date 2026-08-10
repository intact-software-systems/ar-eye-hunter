import { declaredTopologyComputeCaseAtomEndpoints } from './group-topology-server-test-atom-endpoints-compute-case.ts';
import { declaredTopologyComputeInputAtomEndpoints } from './group-topology-server-test-atom-endpoints-compute-input.ts';
import { declaredTopologyComputeSupportAtomEndpoints } from './group-topology-server-test-atom-endpoints-compute-support.ts';
import { declaredTopologyElapsedInputAtomEndpoints } from './group-topology-server-test-atom-endpoints-elapsed-input.ts';
import { declaredTopologyElapsedReadAtomEndpoints } from './group-topology-server-test-atom-endpoints-elapsed-read.ts';
import { declaredTopologyElapsedValidationAtomEndpoints } from './group-topology-server-test-atom-endpoints-elapsed-validation.ts';
import { declaredTopologyExactAuthorityAtomEndpoints } from './group-topology-server-test-atom-endpoints-exact-authority.ts';
import { declaredTopologyExactCommandAtomEndpoints } from './group-topology-server-test-atom-endpoints-exact-command.ts';
import { declaredTopologyExactConfigMutationAtomEndpoints } from './group-topology-server-test-atom-endpoints-exact-config-mutation.ts';
import { declaredTopologyExactConfigResolutionAtomEndpoints } from './group-topology-server-test-atom-endpoints-exact-config-resolution.ts';
import { declaredTopologyExactOwnershipAtomEndpoints } from './group-topology-server-test-atom-endpoints-exact-ownership.ts';
import { declaredTopologyFallbackAtomEndpoints } from './group-topology-server-test-atom-endpoints-fallback.ts';
import { declaredTopologyInputCommandAtomEndpoints } from './group-topology-server-test-atom-endpoints-input-command.ts';
import { declaredTopologyInputReadValueAtomEndpoints } from './group-topology-server-test-atom-endpoints-input-read-values.ts';
import { declaredTopologyInputRuntimeValueAtomEndpoints } from './group-topology-server-test-atom-endpoints-input-runtime-values.ts';
import { declaredTopologyOwnershipAtomEndpoints } from './group-topology-server-test-atom-endpoints-ownership.ts';
import { declaredTopologyResolutionAtomEndpoints } from './group-topology-server-test-atom-endpoints-resolution.ts';
import { declaredTopologySnapshotAuditAtomEndpoints } from './group-topology-server-test-atom-endpoints-snapshot-audit.ts';
import { declaredTopologySnapshotGroupAtomEndpoints } from './group-topology-server-test-atom-endpoints-snapshot-group.ts';
import { declaredTopologySnapshotRevisionAtomEndpoints } from './group-topology-server-test-atom-endpoints-snapshot-revisions.ts';
import { declaredTopologySnapshotMemberAtomEndpoints } from './group-topology-server-test-atom-endpoints-snapshot-members.ts';
import { declaredTopologySupportAtomEndpoints } from './group-topology-server-test-atom-endpoints-support.ts';
import { declaredTopologyValidationAtomEndpoints } from './group-topology-server-test-atom-endpoints-validation.ts';
import type { DeclaredTopologyTestAtomEndpoint } from './group-topology-server-test-atom-endpoint-declaration.ts';

export const declaredTopologyTestAtomEndpoints = [
  ...declaredTopologyExactConfigMutationAtomEndpoints,
  ...declaredTopologyExactConfigResolutionAtomEndpoints,
  ...declaredTopologyExactCommandAtomEndpoints,
  ...declaredTopologyExactAuthorityAtomEndpoints,
  ...declaredTopologyExactOwnershipAtomEndpoints,
  ...declaredTopologyComputeCaseAtomEndpoints,
  ...declaredTopologyComputeInputAtomEndpoints,
  ...declaredTopologyComputeSupportAtomEndpoints,
  ...declaredTopologyFallbackAtomEndpoints,
  ...declaredTopologyValidationAtomEndpoints,
  ...declaredTopologyElapsedValidationAtomEndpoints,
  ...declaredTopologyElapsedInputAtomEndpoints,
  ...declaredTopologyElapsedReadAtomEndpoints,
  ...declaredTopologyResolutionAtomEndpoints,
  ...declaredTopologyInputCommandAtomEndpoints,
  ...declaredTopologyInputReadValueAtomEndpoints,
  ...declaredTopologyInputRuntimeValueAtomEndpoints,
  ...declaredTopologySnapshotRevisionAtomEndpoints,
  ...declaredTopologySnapshotGroupAtomEndpoints,
  ...declaredTopologySnapshotAuditAtomEndpoints,
  ...declaredTopologySnapshotMemberAtomEndpoints,
  ...declaredTopologySupportAtomEndpoints,
  ...declaredTopologyOwnershipAtomEndpoints,
] as const satisfies readonly DeclaredTopologyTestAtomEndpoint[];

export function declaredTopologyTargetConsolidation(
  ownerPath: string,
  ownerCaseId: string,
  ownerAtomId: string,
): Readonly<{ id: string; reason: string }> | null {
  const declaration = declaredTopologyTestAtomEndpoints.find(
    (entry) =>
      entry.ownerPath === ownerPath &&
      entry.ownerCaseId === ownerCaseId &&
      entry.ownerAtomId === ownerAtomId &&
      entry.consolidationId !== null,
  );
  return declaration?.consolidationId && declaration.consolidationReason
    ? { id: declaration.consolidationId, reason: declaration.consolidationReason }
    : null;
}
