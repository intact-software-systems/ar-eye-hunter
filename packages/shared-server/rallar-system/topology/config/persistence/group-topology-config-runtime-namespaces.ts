// prettier-ignore
import type { GroupTopologyConfigGenerationTarget }
  from '../mutation/group-topology-config-mutation-contracts.ts';

export const GROUP_TOPOLOGY_CONFIG_NAMESPACE = 'group-topology:config';
export const GROUP_TOPOLOGY_OVERRIDE_NAMESPACE = 'group-topology:override';
export const GROUP_TOPOLOGY_CONFIG_MUTATION_NAMESPACE = 'group-topology:config-mutation';
export const GROUP_TOPOLOGY_CONFIG_GENERATION_NAMESPACE = 'group-topology:config-generation';
export const GROUP_TOPOLOGY_CONFIG_INVARIANT_GENERATION_NAMESPACE =
  'group-topology:config-invariant-generation';

export function groupTopologyConfigSourceNamespace(
  target: GroupTopologyConfigGenerationTarget,
): string {
  return target === 'config' ? GROUP_TOPOLOGY_CONFIG_NAMESPACE : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
}
