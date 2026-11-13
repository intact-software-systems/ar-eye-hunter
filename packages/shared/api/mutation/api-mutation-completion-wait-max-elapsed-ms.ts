/**
 * The longest a mutation route waits for its AppInbox work to complete before it answers: API-v1's default, which a
 * client derives the budget of a mutation request from.
 */
export const API_MUTATION_COMPLETION_WAIT_MAX_ELAPSED_MS = 30_000;
