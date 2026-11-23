/**
 * A family test's own time limit, covering its conformance recipes and connection readiness. On a GitHub runner against
 * PostgreSQL (run 45009025510) the two-agent family over rtc took 846 s. Two of its scenarios now carry extended recipe
 * budgets: `churn-bounded-tracks` over rtc may take 730 s (180 + 520 s of budget + 30 s grace) where it then took an
 * estimated 150 s, and `buffered-track-drains` 368 s (180 + 158 + 30) where it took an estimated 90 s. The family's
 * worst case is therefore about 1,704 s (28.4 minutes) over rtc and 944 s over ws; the limit clears it with room for a
 * slow runner (`alm-conformance-fairness.test.ts` computes the rtc case from the cells' own budgets). The rtc job that
 * runs the two-agent family runs it first and then `addressed` and `same-context`, which took 1.1 and 1.4 minutes in
 * that run, so the worst case plus those fits the full scope's 55-minute global timeout, and this limit ends a hung
 * two-agent family before the global timeout can.
 */
export const ALM_LANE_FAMILY_TIMEOUT_MS = 2_100_000;
