/**
 * A family test's own time limit, covering its conformance recipes and connection readiness. On a GitHub runner against
 * PostgreSQL (run 45009025510) the two-agent family over rtc took 846 s. Two of its scenarios now carry extended recipe
 * budgets: `churn-bounded-tracks` over rtc may take 727 s (180 + 517 s of budget + 30 s grace) where it then took about
 * 150 s, and `buffered-track-drains` 365 s (180 + 155 + 30) where it took about 90 s. The family's worst case is
 * therefore about 1,698 s (28.3 minutes) over rtc and 941 s over ws; the limit clears it with room for a slow runner and
 * stays below the full scope's 55-minute global timeout.
 */
export const ALM_LANE_FAMILY_TIMEOUT_MS = 2_100_000;
