import { Either } from '@shared/resilience/Either.ts';

import type {
    RallarBlackBoxTestMessagesControlCommand,
    RallarBlackBoxTestState
} from '../rallar-black-box-test-contracts.ts';
import { resolveResultReferencesInText } from '../wait/resolve-wait-match-result-references.ts';

type AlmControlReferenceFields = Pick<RallarBlackBoxTestMessagesControlCommand, 'msgId' | 'ackedMsgId' | 'toPeerId'>;

/**
 * A raw control answers a message the recipe cannot know when it is authored, so its `msgId`, `ackedMsgId` and
 * `toPeerId` may name `{resultCache.<commandId>.<path>}` tokens, such as the received message event of an earlier wait.
 */
export function resolveAlmControlReferences(
    control: AlmControlReferenceFields,
    resultCache: RallarBlackBoxTestState['resultCache']
): Either<string, AlmControlReferenceFields> {
    const msgId = resolveResultReferencesInText(control.msgId, resultCache);
    const ackedMsgId = resolveResultReferencesInText(control.ackedMsgId, resultCache);
    const toPeerId = resolveResultReferencesInText(control.toPeerId, resultCache);
    const unresolved = msgId.left ?? ackedMsgId.left ?? toPeerId.left;
    return unresolved === undefined
        ? Either.ofRight({ msgId: msgId.right!, ackedMsgId: ackedMsgId.right!, toPeerId: toPeerId.right! })
        : Either.ofLeft(
            `messages.control names ${unresolved.reference}, which no earlier command of this recipe returned.`
        );
}
