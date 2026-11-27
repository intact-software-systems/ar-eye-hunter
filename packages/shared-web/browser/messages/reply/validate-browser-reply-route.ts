import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validateRallarWsUserTopicId, type RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/**
 * A reply is a WS unicast on its request's topic, so a request on a topic WS cannot carry has no reply. The issues are
 * the ones the responder's `reply()` is refused with.
 */
export function validateBrowserReplyRoute(request: ALMessage): readonly RallarValidationIssue[] {
    return validateRallarWsUserTopicId(request.route.topicId, '$.topicId').issues;
}
