import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { readALPrincipalBroadcastTarget } from '@shared/al-contracts/read-al-principal-broadcast-target.ts';

/**
 * A hunter sends its suggestions to its own principal's sessions in the room, so a proposal addressed to the local
 * principal is the newest proposal of this hunter; any other is not this hunter's.
 */
export function isRelicPlanningAiProposalOfPrincipal(raw: ALMessage, localPrincipalId: string | undefined): boolean {
    return localPrincipalId !== undefined && readALPrincipalBroadcastTarget(raw)?.principalId === localPrincipalId;
}
