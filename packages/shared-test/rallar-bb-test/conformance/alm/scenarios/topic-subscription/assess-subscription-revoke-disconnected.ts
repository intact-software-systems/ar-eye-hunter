import { EitherCollectors } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../../../../schema/json-schema-validation.ts';
import { toConnectedSessionIds } from '../../identity/assess-alm-acknowledged-identity.ts';
import {
    toRecordedAlmConformanceParticipant,
    type AlmConformanceIdentityParticipant,
    type RecordedAlmConformanceParticipant
} from '../../identity/assess-alm-conformance-identity.ts';

export interface SubscriptionRevokeDisconnectedEvidence {
    readonly runId: string;
    readonly sender: AlmConformanceIdentityParticipant;
    readonly sibling: AlmConformanceIdentityParticipant;
}

/** Joins the sender's receipts to the sibling's sessions: no receipt of the cell may confirm the sibling. */
export function assessSubscriptionRevokeDisconnected(
    { runId, sender, sibling }: SubscriptionRevokeDisconnectedEvidence
): readonly string[] {
    const readings = [sender, sibling].map((participant) => toRecordedAlmConformanceParticipant(runId, participant));
    const issues = EitherCollectors.toListFoldLefts(readings);
    const [recordedSender, recordedSibling] = EitherCollectors.toListFoldRights(readings);
    if (issues.length > 0 || recordedSender === undefined || recordedSibling === undefined) {
        return issues;
    }
    return assessReceiptsLeaveSiblingUnconfirmed(recordedSender, recordedSibling);
}

function assessReceiptsLeaveSiblingUnconfirmed(
    sender: RecordedAlmConformanceParticipant,
    sibling: RecordedAlmConformanceParticipant
): readonly string[] {
    const siblingSessionIds = toConnectedSessionIds(sibling);
    const receipts = sender.participant.recipe.commands.filter((command) => command.kind === 'messages.receipts');
    if (siblingSessionIds.length === 0 || receipts.length === 0) {
        return ['The sibling\'s session or a receipt of the sender is missing.'];
    }
    return receipts.flatMap((command) => {
        const value = sender.results.get(command.commandId!)?.value;
        const confirmed = isJsonRecordValue(value) ? value.confirmedRecipientPeerIds : undefined;
        if (!Array.isArray(confirmed)) {
            return [`${command.handleId}: the receipt names no confirmed recipients.`];
        }
        return confirmed.some((peerId) => typeof peerId === 'string' && siblingSessionIds.includes(peerId))
            ? [`${command.handleId}: the receipt confirms the sibling, whose election was revoked while it was disconnected.`]
            : [];
    });
}
