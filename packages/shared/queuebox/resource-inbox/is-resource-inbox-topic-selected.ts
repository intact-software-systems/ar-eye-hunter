/** Undefined is intentionally unrestricted; a present empty inventory selects no work. */
export function isResourceInboxTopicSelected(
    topicId: string,
    allowedTopicIds: ReadonlySet<string> | undefined
): boolean {
    return allowedTopicIds === undefined || allowedTopicIds.has(topicId);
}
