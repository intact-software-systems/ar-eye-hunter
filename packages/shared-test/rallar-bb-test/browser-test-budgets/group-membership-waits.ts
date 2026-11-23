/** Each group membership request's own budget. */
export const GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS = 10_000;

/** The owner creates the trio's group, then the two other members join it, one request after another. */
export const GROUP_MEMBERSHIP_BOUNDED_WAITS_MS = 3 * GROUP_MEMBERSHIP_REQUEST_TIMEOUT_MS;
