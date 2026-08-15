export const RTC_RTT_LATEST_NAMESPACE = 'rtc-rtt:latest';
export const RTC_RTT_ENDPOINT_ADMISSION_NAMESPACE =
    'rtc-rtt:endpoint-admission';
export const RTC_RTT_RECEIPTS_NAMESPACE = 'rtc-rtt:receipts';

/**
 * Retained only so offline migration can inspect pre-topology-outbox rows.
 * Active runtime cleanup must not protect or depend on this namespace.
 */
export const RTC_RTT_RECOMPUTE_OUTBOX_NAMESPACE = 'rtc-rtt:recompute-outbox';

export const RTC_RTT_PROTECTED_RUNTIME_STATE_NAMESPACES = [
    RTC_RTT_RECEIPTS_NAMESPACE,
] as const;
