import type { AuthSessionStorageKind } from '@shared/api/auth.ts';

import {
    isRallarBlackBoxProviderMode,
    RALLAR_BLACK_BOX_PROVIDER_MODES,
    type RallarBlackBoxProviderMode
} from '../client-defaults.ts';
import type { RallarBlackBoxGeoLocation } from '../distributed-run.ts';
import {
    resolveLaunchValue,
    type BootstrapLaunchSources,
    type LaunchSetting,
    type LaunchValue
} from './resolve-launch-value.ts';

/** A launch value that names a bootstrap setting but does not read as one. */
export interface RallarBlackBoxBootstrapIssue {
    /** The URL parameter or Vite environment variable that carried the value. */
    readonly launchKey: string;
    readonly message: string;
}

export type RallarBlackBoxBootstrapTransport = typeof RALLAR_BLACK_BOX_BOOTSTRAP_TRANSPORTS[number];

export type RallarBlackBoxBootstrapRegister = boolean | typeof REGISTER_IF_NEEDED;

/**
 * The launch settings the bootstrap parses from text. Each is undefined when the launch names no value for it or
 * names one it cannot read; an issue then names the unreadable value. The mode is not among them: the local
 * workbench shares the mode key with its own workspace routing, and every mode other than control names it.
 */
export interface RallarBlackBoxBootstrapLaunchSettings {
    readonly providerMode: RallarBlackBoxProviderMode | undefined;
    readonly autoConnect: boolean | undefined;
    readonly heartbeatIntervalMs: number | undefined;
    readonly statsIntervalMs: number | undefined;
    readonly transport: RallarBlackBoxBootstrapTransport | undefined;
    readonly rallarRegister: RallarBlackBoxBootstrapRegister | undefined;
    readonly rallarAuthStorage: AuthSessionStorageKind | undefined;
    readonly rallarRestoreSession: boolean | undefined;
    readonly rallarLogoutOnClose: boolean | undefined;
    readonly rallarLeaveRoomOnClose: boolean | undefined;
    readonly runnerAgentCount: number | undefined;
    readonly fleetLocation: RallarBlackBoxGeoLocation | undefined;
}

export interface RallarBlackBoxBootstrapLaunchComputed {
    readonly settings: RallarBlackBoxBootstrapLaunchSettings;
    readonly issues: readonly RallarBlackBoxBootstrapIssue[];
}

interface LaunchSettingReader<Value> {
    readonly setting: LaunchSetting;
    readonly expectation: string;
    readonly toValue: (text: string) => Value | undefined;
}

interface LaunchSettingReading<Value> {
    /** Undefined when the launch names no value for the setting or names one it cannot read. */
    readonly value: Value | undefined;
    readonly issues: readonly RallarBlackBoxBootstrapIssue[];
}

export const RALLAR_BLACK_BOX_BOOTSTRAP_TRANSPORTS = ['realtime', 'messages.rtc'] as const;

const STRICT_DECIMAL_NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;
const NON_NEGATIVE_INTEGER = /^\d+$/;
const TRUE_TEXTS = ['1', 'true', 'yes', 'on'];
const FALSE_TEXTS = ['0', 'false', 'no', 'off'];
const REGISTER_IF_NEEDED = 'if-needed';
const AUTH_STORAGE_KINDS: readonly AuthSessionStorageKind[] = ['local', 'session'];
const BOOLEAN_EXPECTATION = `one of ${[...TRUE_TEXTS, ...FALSE_TEXTS].join(', ')}`;
const INTERVAL_EXPECTATION = 'a non-negative integer';

const PROVIDER_READER: LaunchSettingReader<RallarBlackBoxProviderMode> = {
    setting: 'provider',
    expectation: `one of ${RALLAR_BLACK_BOX_PROVIDER_MODES.join(', ')}`,
    toValue: (text) => isRallarBlackBoxProviderMode(text) ? text : undefined
};
const TRANSPORT_READER: LaunchSettingReader<RallarBlackBoxBootstrapTransport> = {
    setting: 'transport',
    expectation: `one of ${RALLAR_BLACK_BOX_BOOTSTRAP_TRANSPORTS.join(', ')}`,
    toValue: (text) => RALLAR_BLACK_BOX_BOOTSTRAP_TRANSPORTS.find((transport) => transport === text)
};
const REGISTER_READER: LaunchSettingReader<RallarBlackBoxBootstrapRegister> = {
    setting: 'rallarRegister',
    expectation: `one of ${REGISTER_IF_NEEDED}, ${[...TRUE_TEXTS, ...FALSE_TEXTS].join(', ')}`,
    toValue: (text) => text.toLowerCase() === REGISTER_IF_NEEDED ? REGISTER_IF_NEEDED : toLaunchBoolean(text)
};
const AUTH_STORAGE_READER: LaunchSettingReader<AuthSessionStorageKind> = {
    setting: 'rallarAuthStorage',
    expectation: `one of ${AUTH_STORAGE_KINDS.join(', ')}`,
    toValue: (text) => AUTH_STORAGE_KINDS.find((kind) => kind === text.toLowerCase())
};
const RUNNER_AGENT_COUNT_READER: LaunchSettingReader<number> = {
    setting: 'runnerAgentCount',
    expectation: 'a positive integer',
    toValue: (text) => NON_NEGATIVE_INTEGER.test(text) && Number(text) > 0 ? Number(text) : undefined
};
const LATITUDE_READER = toCoordinateReader('fleetLatitude', 90);
const LONGITUDE_READER = toCoordinateReader('fleetLongitude', 180);

export function computeRallarBlackBoxBootstrapLaunch(
    sources: BootstrapLaunchSources
): RallarBlackBoxBootstrapLaunchComputed {
    const readings = {
        providerMode: toLaunchSettingReading(sources, PROVIDER_READER),
        autoConnect: toLaunchSettingReading(sources, toBooleanReader('autoConnect')),
        heartbeatIntervalMs: toLaunchSettingReading(sources, toIntervalReader('heartbeatIntervalMs')),
        statsIntervalMs: toLaunchSettingReading(sources, toIntervalReader('statsIntervalMs')),
        transport: toLaunchSettingReading(sources, TRANSPORT_READER),
        rallarRegister: toLaunchSettingReading(sources, REGISTER_READER),
        rallarAuthStorage: toLaunchSettingReading(sources, AUTH_STORAGE_READER),
        rallarRestoreSession: toLaunchSettingReading(sources, toBooleanReader('rallarRestoreSession')),
        rallarLogoutOnClose: toLaunchSettingReading(sources, toBooleanReader('rallarLogoutOnClose')),
        rallarLeaveRoomOnClose: toLaunchSettingReading(sources, toBooleanReader('rallarLeaveRoomOnClose')),
        runnerAgentCount: toLaunchSettingReading(sources, RUNNER_AGENT_COUNT_READER),
        fleetLatitude: toLaunchSettingReading(sources, LATITUDE_READER),
        fleetLongitude: toLaunchSettingReading(sources, LONGITUDE_READER)
    };
    return {
        settings: {
            providerMode: readings.providerMode.value,
            autoConnect: readings.autoConnect.value,
            heartbeatIntervalMs: readings.heartbeatIntervalMs.value,
            statsIntervalMs: readings.statsIntervalMs.value,
            transport: readings.transport.value,
            rallarRegister: readings.rallarRegister.value,
            rallarAuthStorage: readings.rallarAuthStorage.value,
            rallarRestoreSession: readings.rallarRestoreSession.value,
            rallarLogoutOnClose: readings.rallarLogoutOnClose.value,
            rallarLeaveRoomOnClose: readings.rallarLeaveRoomOnClose.value,
            runnerAgentCount: readings.runnerAgentCount.value,
            fleetLocation: toFleetLocation(sources, readings.fleetLatitude.value, readings.fleetLongitude.value)
        },
        issues: Object.values(readings).flatMap((reading) => reading.issues)
    };
}

function toLaunchSettingReading<Value>(
    sources: BootstrapLaunchSources,
    reader: LaunchSettingReader<Value>
): LaunchSettingReading<Value> {
    const launch = resolveLaunchValue(sources, reader.setting);
    const value = launch === undefined ? undefined : reader.toValue(launch.text);
    return launch === undefined || value !== undefined
        ? { value, issues: [] }
        : { value, issues: [toUnreadableLaunchIssue(launch, reader.expectation)] };
}

function toUnreadableLaunchIssue(launch: LaunchValue, expectation: string): RallarBlackBoxBootstrapIssue {
    return {
        launchKey: launch.launchKey,
        message: `${launch.launchKey} must be ${expectation}, not '${launch.text}'.`
    };
}

/**
 * Launch coordinates are the operator's explicit placement, so the agent reports them as exact. The location is
 * optional: a label or one coordinate without the other places no location, as the headless worker forwards them.
 */
function toFleetLocation(
    sources: BootstrapLaunchSources,
    latitude: number | undefined,
    longitude: number | undefined
): RallarBlackBoxGeoLocation | undefined {
    if (latitude === undefined || longitude === undefined) {
        return undefined;
    }
    const label = resolveLaunchValue(sources, 'fleetLocationLabel')?.text;
    return { latitude, longitude, ...(label === undefined ? {} : { label }), precision: 'exact' };
}

function toBooleanReader(setting: LaunchSetting): LaunchSettingReader<boolean> {
    return { setting, expectation: BOOLEAN_EXPECTATION, toValue: toLaunchBoolean };
}

function toIntervalReader(setting: LaunchSetting): LaunchSettingReader<number> {
    return {
        setting,
        expectation: INTERVAL_EXPECTATION,
        toValue: (text) => NON_NEGATIVE_INTEGER.test(text) ? Number(text) : undefined
    };
}

function toCoordinateReader(setting: LaunchSetting, limit: number): LaunchSettingReader<number> {
    return {
        setting,
        expectation: `a decimal number from -${limit} to ${limit}`,
        toValue: (text) => toLaunchCoordinate(text, limit)
    };
}

function toLaunchBoolean(text: string): boolean | undefined {
    const normalized = text.toLowerCase();
    if (TRUE_TEXTS.includes(normalized)) {
        return true;
    }
    return FALSE_TEXTS.includes(normalized) ? false : undefined;
}

function toLaunchCoordinate(text: string, limit: number): number | undefined {
    if (!STRICT_DECIMAL_NUMBER.test(text)) {
        return undefined;
    }
    const coordinate = Number(text);
    return Number.isFinite(coordinate) && coordinate >= -limit && coordinate <= limit ? coordinate : undefined;
}
