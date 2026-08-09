/**
 * Governs the group-formation Phase 1 behaviors that have an operational
 * rollback: conditional bounded bootstrap overlays and the outbound dial
 * budget. 'legacy-star' restores the unconditional full-membership star and
 * unbounded dialing. Overlay admission precedence (server supersedes
 * bootstrap) is not mode-dependent.
 */
export type RtcGroupFormationMode = 'bounded-bootstrap' | 'legacy-star';

export const DEFAULT_RTC_GROUP_FORMATION_MODE: RtcGroupFormationMode = 'bounded-bootstrap';

export function resolveRtcGroupFormationMode(
    mode: RtcGroupFormationMode | undefined,
): RtcGroupFormationMode {
    return mode ?? DEFAULT_RTC_GROUP_FORMATION_MODE;
}
