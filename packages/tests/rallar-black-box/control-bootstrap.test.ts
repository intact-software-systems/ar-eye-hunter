import { describe, expect, it } from 'vitest';
import {
    rallarBlackBoxProviderModeFromConfig,
    resolveRallarBlackBoxBootstrapConfig,
    validateRallarBlackBoxProviderConfig,
} from '../../../apps/rallar-black-box/src/runtime-store.ts';

describe('rallar-black-box control bootstrap', () => {
    it('enables remote control mode from URL autoConnect params', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?controlUrl=ws://127.0.0.1:5180/control&runId=run-url&agentId=agent-url&autoConnect=1',
            {},
        );

        expect(bootstrap).toMatchObject({
            mode: 'control-agent',
            autoConnect: true,
            controlUrl: 'ws://127.0.0.1:5180/control',
            runId: 'run-url',
            agentId: 'agent-url',
            source: 'url',
        });
    });

    it('uses control mode as an auto-connect shorthand', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&agentId=agent-mode',
            {},
        );

        expect(bootstrap.mode).toBe('control-agent');
        expect(bootstrap.autoConnect).toBe(true);
        expect(bootstrap.agentId).toBe('agent-mode');
    });

    it('keeps local workbench defaults without URL or env config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig('', {});

        expect(bootstrap).toMatchObject({
            mode: 'local-workbench',
            autoConnect: false,
            controlUrl: 'ws://localhost:5180/control',
            providerMode: 'simulated',
            runId: 'local-workbench-run',
            agentId: 'visible-agent-local',
            environment: 'local',
            apiBaseUrl: 'https://api.example.invalid',
            applicationId: 'rallar-black-box',
            workspaceId: 'default',
            actor: 'alice',
            sessionId: 'visible-session-alice',
            roomId: 'rallar-black-box-room',
            transport: 'realtime',
            source: 'default',
        });
    });

    it('uses Vite environment values when URL params are absent', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig('', {
            VITE_RALLAR_CONTROL_URL: 'ws://control.example.test/control',
            VITE_RALLAR_AUTO_CONNECT: 'true',
            VITE_RALLAR_RUN_ID: 'run-env',
            VITE_RALLAR_AGENT_ID: 'agent-env',
        });

        expect(bootstrap).toMatchObject({
            mode: 'control-agent',
            autoConnect: true,
            controlUrl: 'ws://control.example.test/control',
            runId: 'run-env',
            agentId: 'agent-env',
            source: 'environment',
        });
    });

    it('uses Vite environment values for local identity defaults', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig('', {
            VITE_RALLAR_ENVIRONMENT: 'staging',
            VITE_RALLAR_API_BASE_URL: 'https://api.example.test',
            VITE_RALLAR_APPLICATION_ID: 'app-env',
            VITE_RALLAR_WORKSPACE_ID: 'workspace-env',
            VITE_RALLAR_ACTOR: 'bob',
            VITE_RALLAR_SESSION_ID: 'bob-session',
            VITE_RALLAR_ROOM_ID: 'room-env',
            VITE_RALLAR_TRANSPORT: 'messages.rtc',
            VITE_RALLAR_HEARTBEAT_INTERVAL_MS: '250',
            VITE_RALLAR_AGENT_REGION: 'eu-north',
            VITE_RALLAR_AGENT_PROVIDER: 'hetzner',
            VITE_RALLAR_AGENT_DATACENTER: 'fsn1',
            VITE_RALLAR_AGENT_HOST_ID: 'host-1',
            VITE_RALLAR_AGENT_POOL_ID: 'pool-a',
            VITE_RALLAR_AGENT_DEPLOYMENT_ID: 'deploy-1',
            VITE_RALLAR_AGENT_BROWSER_NAME: 'chromium',
            VITE_RALLAR_AGENT_BROWSER_VERSION: '126',
            VITE_RALLAR_AGENT_OS: 'linux',
            VITE_RALLAR_AGENT_TAGS: 'canary,rtc',
        });

        expect(bootstrap).toMatchObject({
            mode: 'local-workbench',
            environment: 'staging',
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'app-env',
            workspaceId: 'workspace-env',
            actor: 'bob',
            sessionId: 'bob-session',
            roomId: 'room-env',
            transport: 'messages.rtc',
            heartbeatIntervalMs: 250,
            fleetRegion: 'eu-north',
            fleetProvider: 'hetzner',
            fleetDatacenter: 'fsn1',
            fleetHostId: 'host-1',
            fleetAgentPoolId: 'pool-a',
            fleetDeploymentId: 'deploy-1',
            fleetBrowserName: 'chromium',
            fleetBrowserVersion: '126',
            fleetOs: 'linux',
            fleetTags: ['canary', 'rtc'],
            source: 'environment',
        });
    });

    it('lets URL fleet labels override environment labels', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?fleetRegion=us-east&fleetProvider=hetzner&fleetTags=edge,video',
            {
                VITE_RALLAR_AGENT_REGION: 'eu-north',
                VITE_RALLAR_AGENT_PROVIDER: 'local',
            },
        );

        expect(bootstrap).toMatchObject({
            fleetRegion: 'us-east',
            fleetProvider: 'hetzner',
            fleetTags: ['edge', 'video'],
        });
    });

    it('selects browser-rallar provider only when requested', () => {
        const fromUrl = resolveRallarBlackBoxBootstrapConfig(
            '?provider=browser-rallar&apiBaseUrl=https://api.example.test&rallarUsername=alice&rallarPassword=secret',
            {},
        );
        const fromEnv = resolveRallarBlackBoxBootstrapConfig('', {
            VITE_RALLAR_PROVIDER: 'browser-rallar',
            VITE_RALLAR_API_BASE_URL: 'https://api.example.test',
            VITE_RALLAR_RESTORE_SESSION: 'true',
            VITE_RALLAR_LOGOUT_ON_CLOSE: 'true',
            VITE_RALLAR_LEAVE_ROOM_ON_CLOSE: 'false',
        });
        const invalid = resolveRallarBlackBoxBootstrapConfig('?provider=unknown', {});

        expect(fromUrl.providerMode).toBe('browser-rallar');
        expect(fromUrl.rallarUsername).toBe('alice');
        expect(fromUrl.rallarPassword).toBe('secret');
        expect(fromEnv.providerMode).toBe('browser-rallar');
        expect(fromEnv.rallarRestoreSession).toBe(true);
        expect(fromEnv.rallarLogoutOnClose).toBe(true);
        expect(fromEnv.rallarLeaveRoomOnClose).toBe(false);
        expect(invalid.providerMode).toBe('simulated');
    });

    it('validates browser-rallar provider config before real execution exists', () => {
        expect(validateRallarBlackBoxProviderConfig({
            control: {
                providerMode: 'simulated',
            },
        })).toBeUndefined();

        expect(validateRallarBlackBoxProviderConfig({
            apiBaseUrl: 'https://api.example.invalid',
            control: {
                providerMode: 'browser-rallar',
            },
        })?.message).toContain('real Rallar API base URL');

        expect(validateRallarBlackBoxProviderConfig({
            apiBaseUrl: 'https://api.example.test',
            control: {
                providerMode: 'browser-rallar',
            },
        })?.message).toContain('username/password or restoreSession=true');

        expect(validateRallarBlackBoxProviderConfig({
            apiBaseUrl: 'https://api.example.test',
            rallar: {
                token: 'unsupported-bare-token',
            },
            control: {
                providerMode: 'browser-rallar',
            },
        })?.message).toContain('username/password or restoreSession=true');

        expect(validateRallarBlackBoxProviderConfig({
            apiBaseUrl: 'https://api.example.test',
            rallar: {
                username: 'alice',
                password: 'secret',
            },
            control: {
                providerMode: 'browser-rallar',
            },
        })).toBeUndefined();

        expect(validateRallarBlackBoxProviderConfig({
            apiBaseUrl: 'https://api.example.test',
            rallar: {
                restoreSession: true,
            },
            control: {
                providerMode: 'browser-rallar',
            },
        })).toBeUndefined();

        expect(rallarBlackBoxProviderModeFromConfig({
            defaults: {
                providerMode: 'browser-rallar',
            },
        })).toBe('browser-rallar');
    });
});
