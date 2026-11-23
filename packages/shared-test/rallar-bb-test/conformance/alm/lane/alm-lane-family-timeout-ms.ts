/**
 * A family test's own time limit, covering its conformance recipes and connection readiness. On a GitHub runner against
 * PostgreSQL (run 45009025510) the two-agent family over rtc took 846 s. Two of its scenarios now carry extended recipe
 * budgets: `churn-bounded-tracks` over rtc may take 727 s (180 + 517 s of budget + 30 s grace) where it then took an
 * estimated 150 s, and `buffered-track-drains` 365 s (180 + 155 + 30) where it took an estimated 90 s. The family's
 * worst case is therefore about 1,698 s (28.3 minutes) over rtc and 941 s over ws; the limit clears it with room for a
 * slow runner. The rtc job that runs the two-agent family also runs `addressed` and `same-context`, which took at most
 * 22.4 minutes together in that run (its one rtc job took 36.5 minutes, two-agent 14.1 of them), so the worst case plus
 * those still fits the full scope's 55-minute global timeout. A hung two-agent family is not always ended by this limit
 * first: in the rtc job it starts after `addressed` and `same-context`, so after up to 22.4 minutes of those the
 * 55-minute global timeout can end it before its own 35 minutes run out.
 */
export const ALM_LANE_FAMILY_TIMEOUT_MS = 2_100_000;
