import { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxTestMessagesControlCommand,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { resolveResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';

type AlmControlReferenceFields = Pick<
    RallarBlackBoxTestMessagesControlCommand,
    'msgId' | 'ackedMsgId' | 'toPeerId' | 'logicalRecipientPeerId'
>;

/**
 * A raw control answers a message the recipe cannot know when it is authored, so its `msgId`, `ackedMsgId` and
 * `toPeerId` (and the `logicalRecipientPeerId` it may state) may name `{resultCache.<commandId>.<path>}` tokens, such
 * as the received message event of an earlier wait.
 */
export function resolveAlmControlReferences(
    control: AlmControlReferenceFields,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<string, AlmControlReferenceFields> {
    const msgId = resolveResultReferencesInText(control.msgId, resultCache);
    const ackedMsgId = resolveResultReferencesInText(control.ackedMsgId, resultCache);
    const toPeerId = resolveResultReferencesInText(control.toPeerId, resultCache);
    const logicalRecipientPeerId = control.logicalRecipientPeerId === undefined
        ? undefined
        : resolveResultReferencesInText(control.logicalRecipientPeerId, resultCache);
    const unresolved = msgId.left ?? ackedMsgId.left ?? toPeerId.left ?? logicalRecipientPeerId?.left;
    return unresolved === undefined
        ? Either.ofRight({
            msgId: msgId.right!,
            ackedMsgId: ackedMsgId.right!,
            toPeerId: toPeerId.right!,
            ...(logicalRecipientPeerId === undefined ? {} : { logicalRecipientPeerId: logicalRecipientPeerId.right! })
        })
        : Either.ofLeft(
            `messages.control names ${unresolved.reference}, which no earlier command of this recipe returned.`
        );
}
