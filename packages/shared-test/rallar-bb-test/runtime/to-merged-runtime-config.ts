import type { RallarBlackBoxTestConfig } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from './decode-runtime-result-values.ts';

const RALLAR_CONFIG_AUTH_INTENT_KEYS = [
    'username',
    'password',
    'token',
    'register',
    'displayName',
    'restoreSession'
] as const;

const RALLAR_CONFIG_INHERITED_KEYS = [
    ...RALLAR_CONFIG_AUTH_INTENT_KEYS,
    'logoutOnClose',
    'leaveRoomOnClose',
    'timeoutMs'
] as const;

/** A configure without auth intent keeps the previous connection identity, so reconfiguring cannot log out. */
export function toMergedRuntimeConfig(
    current: RallarBlackBoxTestConfig | undefined,
    next: RallarBlackBoxTestConfig
): RallarBlackBoxTestConfig {
    if (!next.rallar) {
        return next;
    }
    const nextRallar = decodeRecord(next.rallar);
    if (RALLAR_CONFIG_AUTH_INTENT_KEYS.some((key) => Object.hasOwn(nextRallar, key))) {
        return next;
    }
    const currentRallar = decodeRecord(current?.rallar);
    const inherited = Object.fromEntries(
        RALLAR_CONFIG_INHERITED_KEYS
            .filter((key) => currentRallar[key] !== undefined)
            .map((key) => [key, currentRallar[key]])
    );
    return Object.keys(inherited).length === 0 ? next : { ...next, rallar: { ...inherited, ...nextRallar } };
}
