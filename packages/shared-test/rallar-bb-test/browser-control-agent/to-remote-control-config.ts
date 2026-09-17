import { readSession } from '@shared/api/auth.ts';
import type { RallarBlackBoxBootstrapConfig } from '../browser-control-agent-config.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../client-defaults.ts';
import type { RallarBlackBoxTestConfig, RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

export interface ToRemoteControlConfigInput {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly hasStoredAuthSession: boolean;
}

export interface ToRallarBlackBoxRallarConfigInput {
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly hasStoredAuthSession: boolean;
}

export function toRemoteControlConfig(input: ToRemoteControlConfigInput): RallarBlackBoxTestConfig {
    const { bootstrap } = input;
    return {
        runId: bootstrap.runId,
        agentId: bootstrap.agentId,
        environment: bootstrap.environment,
        apiBaseUrl: bootstrap.apiBaseUrl,
        actor: bootstrap.actor,
        sessionId: bootstrap.sessionId,
        roomId: bootstrap.roomId,
        transport: bootstrap.transport,
        rallar: toRallarBlackBoxRallarConfig(input),
        control: {
            mode: 'remote-control',
            providerMode: bootstrap.providerMode,
            protocolVersion: 1,
            connected: bootstrap.autoConnect,
            autoConnect: bootstrap.autoConnect,
            url: bootstrap.controlUrl,
            source: bootstrap.source
        },
        defaults: {
            timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs,
            connection: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.remoteConnection,
            providerMode: bootstrap.providerMode,
            applicationId: bootstrap.applicationId,
            workspaceId: bootstrap.workspaceId,
            groupId: bootstrap.roomId
        },
        fleet: toRallarBlackBoxFleetConfig(bootstrap)
    };
}

/** A simulated agent signs in with the local demo credentials; a real agent signs in, registers or restores. */
export function toRallarBlackBoxRallarConfig(input: ToRallarBlackBoxRallarConfigInput): RallarBlackBoxTestRecord {
    const { bootstrap } = input;
    if (bootstrap.providerMode === 'simulated') {
        return {
            username: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoUsername,
            password: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoPassword,
            token: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.demoToken
        };
    }

    return {
        ...(bootstrap.rallarUsername ? { username: bootstrap.rallarUsername } : {}),
        ...(bootstrap.rallarPassword ? { password: bootstrap.rallarPassword } : {}),
        ...(bootstrap.rallarRegister ? { register: bootstrap.rallarRegister } : {}),
        ...(bootstrap.rallarRestoreSession || input.hasStoredAuthSession ? { restoreSession: true } : {}),
        ...(bootstrap.rallarLogoutOnClose ? { logoutOnClose: true } : {}),
        leaveRoomOnClose: bootstrap.rallarLeaveRoomOnClose
    };
}

export function toRallarBlackBoxFleetConfig(
    bootstrap: RallarBlackBoxBootstrapConfig
): RallarBlackBoxTestConfig['fleet'] {
    const fleet = {
        region: bootstrap.fleetRegion,
        provider: bootstrap.fleetProvider,
        datacenter: bootstrap.fleetDatacenter,
        hostId: bootstrap.fleetHostId,
        agentPoolId: bootstrap.fleetAgentPoolId,
        deploymentId: bootstrap.fleetDeploymentId,
        browserName: bootstrap.fleetBrowserName,
        browserVersion: bootstrap.fleetBrowserVersion,
        os: bootstrap.fleetOs,
        tags: bootstrap.fleetTags,
        location: bootstrap.fleetLocation
    };
    return Object.values(fleet).some((fact) => fact !== undefined) ? fleet : undefined;
}

export function readBrowserAuthSessionPresence(): boolean {
    if (typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined') {
        return false;
    }

    try {
        return readSession() !== undefined;
    }
    catch {
        return false;
    }
}
