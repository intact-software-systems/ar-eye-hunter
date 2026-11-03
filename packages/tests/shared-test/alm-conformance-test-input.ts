import {
    ALM_CONFORMANCE_LANE_FAMILIES,
    type CreateAlmConformanceRecipesInput
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

/** Each role's principal as the lane resolves it: the sender's pages and its sibling share one, as do the third roles. */
export const CONFORMANCE_PRINCIPAL_IDS: CreateAlmConformanceRecipesInput['principalIdsByRole'] = {
    sender: 'principal-alice',
    successor: 'principal-alice',
    sibling: 'principal-alice',
    receiver: 'principal-bob',
    'recipient-b': 'principal-charlie',
    'publisher-b': 'principal-charlie'
};

export function toConformanceInput(
    carrier: CreateAlmConformanceRecipesInput['carrier']
): CreateAlmConformanceRecipesInput {
    return {
        group,
        carrier,
        typeId: 'alm.conformance',
        senderConnection: 'sender',
        receiverConnection: 'receiver',
        deadlineMs: 18_000,
        laneFamilies: ALM_CONFORMANCE_LANE_FAMILIES,
        principalIdsByRole: CONFORMANCE_PRINCIPAL_IDS
    };
}
