import { readALTargetGroupRef, type ALMessage } from '../al-contract.ts';

/**
 * A room unicast routes in its room id whatever context the request used, since the browser sender and the server
 * ingress both refuse any other; a request that named no room is answered in the context it used.
 */
export function toALReplyContextId(request: ALMessage): string {
    return readALTargetGroupRef(request)?.groupId ?? request.route.contextId;
}
