import { describe, expect, it } from 'vitest';
import { resolveRallarBlackBoxBootstrapConfig } from '../../../packages/shared-test/rallar-bb-test/browser-control-agent-config.ts';
import {
    toRallarBlackBoxFleetConfig,
    toRallarBlackBoxRallarConfig,
    toRemoteControlConfig
} from '../../../packages/shared-test/rallar-bb-test/browser-control-agent/to-remote-control-config.ts';
import {
    resolveRallarBlackBoxConfigProviderMode,
    validateRallarBlackBoxProviderConfig
} from '../../../packages/shared-test/rallar-bb-test/browser-control-agent/validate-rallar-black-box-provider-config.ts';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS, resolveRallarBlackBoxProviderMode } from '../../../packages/shared-test/rallar-bb-test/client-defaults.ts';

describe('browser control-agent bootstrap config', () => {
    it('parses URL params into a browser-rallar control-agent bootstrap config', () => {
        const config = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&controlUrl=wss%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-1&agentId=agent-1&apiBaseUrl=https%3A%2F%2Fapi.example.test&roomId=room-1&rallarUsername=alice&rallarPassword=secret&rallarRegister=1&fleetTags=canary%2Crtc',
            {},
            ''
        );

        expect(config.mode).toBe('control-agent');
        expect(config.autoConnect).toBe(true);
        expect(config.providerMode).toBe('browser-rallar');
        expect(config.controlUrl).toBe('wss://control.example.test/control');
        expect(config.runId).toBe('run-1');
        expect(config.agentId).toBe('agent-1');
        expect(config.apiBaseUrl).toBe('https://api.example.test');
        expect(config.roomId).toBe('room-1');
        expect(config.rallarUsername).toBe('alice');
        expect(config.rallarPassword).toBe('secret');
        expect(config.rallarRegister).toBe(true);
        expect(config.fleetTags).toEqual(['canary', 'rtc']);
        expect(config.source).toBe('url');
    });

    it('selects the provider and control mode only from their canonical launch keys', () => {
        expect(resolveRallarBlackBoxBootstrapConfig('?mode=control-agent&providerMode=browser-rallar', {}, ''))
            .toMatchObject({ mode: 'local-workbench', providerMode: 'simulated' });
        expect(resolveRallarBlackBoxBootstrapConfig('', { VITE_RALLAR_BOOTSTRAP_MODE: 'control-agent' }, ''))
            .toMatchObject({ mode: 'local-workbench' });
        expect(resolveRallarBlackBoxBootstrapConfig('', { VITE_RALLAR_PROVIDER_MODE: 'browser-rallar' }, ''))
            .toMatchObject({ providerMode: 'simulated', source: 'default' });
    });

    it('carries no issues for a launch whose every value reads as its setting', () => {
        expect(
            resolveRallarBlackBoxBootstrapConfig(
                '?mode=control&autoConnect=0&provider=browser-rallar&statsIntervalMs=0&transport=messages.rtc&rallarRegister=if-needed&rallarAuthStorage=session&rallarRestoreSession=off&rallarLogoutOnClose=YES&runnerAgentCount=4&fleetLatitude=-12.5&fleetLongitude=180&fleetLocationLabel=edge',
                { VITE_RALLAR_HEARTBEAT_INTERVAL_MS: '250', VITE_RALLAR_LEAVE_ROOM_ON_CLOSE: 'false' },
                ''
            ).issues
        ).toEqual([]);
    });

    it('reports every launch value it cannot read as its setting, naming the key that carried it', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?autoConnect=maybe&transport=ws&rallarRegister=sometimes&rallarAuthStorage=cookie&fleetLongitude=10',
            {
                VITE_RALLAR_HEARTBEAT_INTERVAL_MS: '250ms',
                VITE_RALLAR_STATS_INTERVAL_MS: '-5',
                VITE_RALLAR_LOGOUT_ON_CLOSE: 'sure'
            },
            ''
        );

        expect(bootstrap.issues).toEqual([
            { launchKey: 'autoConnect', message: 'autoConnect must be one of 1, true, yes, on, 0, false, no, off, not \'maybe\'.' },
            {
                launchKey: 'VITE_RALLAR_HEARTBEAT_INTERVAL_MS',
                message: 'VITE_RALLAR_HEARTBEAT_INTERVAL_MS must be a non-negative integer, not \'250ms\'.'
            },
            {
                launchKey: 'VITE_RALLAR_STATS_INTERVAL_MS',
                message: 'VITE_RALLAR_STATS_INTERVAL_MS must be a non-negative integer, not \'-5\'.'
            },
            { launchKey: 'transport', message: 'transport must be one of realtime, messages.rtc, not \'ws\'.' },
            {
                launchKey: 'rallarRegister',
                message: 'rallarRegister must be one of if-needed, 1, true, yes, on, 0, false, no, off, not \'sometimes\'.'
            },
            { launchKey: 'rallarAuthStorage', message: 'rallarAuthStorage must be one of local, session, not \'cookie\'.' },
            {
                launchKey: 'VITE_RALLAR_LOGOUT_ON_CLOSE',
                message: 'VITE_RALLAR_LOGOUT_ON_CLOSE must be one of 1, true, yes, on, 0, false, no, off, not \'sure\'.'
            },
            { launchKey: 'fleetLongitude', message: 'fleetLongitude needs fleetLatitude to place the agent.' }
        ]);
    });

    it('reports a fleet location label without coordinates', () => {
        expect(resolveRallarBlackBoxBootstrapConfig('', { VITE_RALLAR_AGENT_LOCATION_LABEL: 'rack 3' }, '').issues)
            .toEqual([{
                launchKey: 'VITE_RALLAR_AGENT_LOCATION_LABEL',
                message: 'VITE_RALLAR_AGENT_LOCATION_LABEL needs a fleet latitude and longitude to place the agent.'
            }]);
    });

    it('takes no Rallar access token from the launch URL or the Vite environment', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?rallarToken=url-token',
            { VITE_RALLAR_TOKEN: 'environment-token' },
            ''
        );

        expect(bootstrap).not.toHaveProperty('rallarToken');
        expect(JSON.stringify(bootstrap)).not.toMatch(/url-token|environment-token/);
        expect(bootstrap.source).toBe('default');
    });

    it('reads a runtime config provider mode only from control or defaults providerMode', () => {
        expect(resolveRallarBlackBoxConfigProviderMode({
            control: { provider: 'browser-rallar' },
            defaults: { provider: 'browser-rallar' }
        })).toBe('simulated');
    });

    it('writes the heartbeat, stats and runner agent count defaults explicitly', () => {
        expect(resolveRallarBlackBoxBootstrapConfig('', {}, '')).toMatchObject({
            heartbeatIntervalMs: 10_000,
            statsIntervalMs: 5_000,
            runnerAgentCount: 1
        });
    });

    it('builds the exact remote-control runtime config used by browser agents', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&controlUrl=wss%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-2&agentId=agent-2&apiBaseUrl=https%3A%2F%2Fapi.example.test&applicationId=rallar-server&workspaceId=default&roomId=room-2&actor=agent-2&sessionId=session-2&rallarUsername=bob&rallarPassword=secret&rallarLeaveRoomOnClose=0',
            {},
            ''
        );

        const runtimeConfig = toRemoteControlConfig({ bootstrap, hasStoredAuthSession: false });

        expect(runtimeConfig.runId).toBe('run-2');
        expect(runtimeConfig.agentId).toBe('agent-2');
        expect(runtimeConfig.apiBaseUrl).toBe('https://api.example.test');
        expect(runtimeConfig.actor).toBe('agent-2');
        expect(runtimeConfig.sessionId).toBe('session-2');
        expect(runtimeConfig.roomId).toBe('room-2');
        expect(runtimeConfig.rallar).toEqual({
            username: 'bob',
            password: 'secret',
            leaveRoomOnClose: false
        });
        expect(runtimeConfig.control).toMatchObject({
            mode: 'remote-control',
            providerMode: 'browser-rallar',
            connected: true,
            autoConnect: true,
            url: 'wss://control.example.test/control',
            source: 'url'
        });
        expect(runtimeConfig.defaults).toMatchObject({
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'room-2'
        });
    });

    it('passes register-if-needed through to the browser runtime', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.test&rallarUsername=alice&rallarPassword=secret&rallarRegister=if-needed',
            {},
            ''
        );

        const runtimeConfig = toRemoteControlConfig({ bootstrap, hasStoredAuthSession: false });

        expect(bootstrap.rallarRegister).toBe('if-needed');
        expect(runtimeConfig.rallar?.register).toBe('if-needed');
    });

    it('passes per-tab auth storage through bootstrap without putting tickets in runtime config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.test&rallarAuthStorage=session&actor=alice&sessionId=agent-session&rallarRestoreSession=1',
            {},
            '#agentSessionTicket=one-time-ticket'
        );

        const runtimeConfig = toRemoteControlConfig({ bootstrap, hasStoredAuthSession: false });

        expect(bootstrap.rallarAuthStorage).toBe('session');
        expect(bootstrap.rallarAgentSessionTicket).toBe('one-time-ticket');
        expect(runtimeConfig.rallar?.restoreSession).toBe(true);
        expect(JSON.stringify(runtimeConfig)).not.toContain('one-time-ticket');
    });

    it('restores a stored browser auth session the caller found', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.test',
            {},
            ''
        );

        expect(toRallarBlackBoxRallarConfig({ bootstrap, hasStoredAuthSession: true })).toEqual({
            restoreSession: true,
            leaveRoomOnClose: true
        });
        expect(toRallarBlackBoxRallarConfig({ bootstrap, hasStoredAuthSession: false })).toEqual({
            leaveRoomOnClose: true
        });
    });

    it('preserves explicit fleet location metadata in remote-control runtime config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&fleetRegion=eu-north&fleetProvider=hetzner&fleetDatacenter=fsn1&fleetLatitude=52.5333&fleetLongitude=13.3833&fleetLocationLabel=fsn1%20operator%20rack',
            {},
            ''
        );
        const runtimeConfig = toRemoteControlConfig({ bootstrap, hasStoredAuthSession: false });

        expect(bootstrap.fleetLocation).toEqual({
            latitude: 52.5333,
            longitude: 13.3833,
            label: 'fsn1 operator rack',
            precision: 'exact'
        });
        expect(toRallarBlackBoxFleetConfig(bootstrap)).toMatchObject({
            region: 'eu-north',
            provider: 'hetzner',
            datacenter: 'fsn1',
            location: {
                latitude: 52.5333,
                longitude: 13.3833,
                label: 'fsn1 operator rack',
                precision: 'exact'
            }
        });
        expect(runtimeConfig.fleet).toMatchObject({
            location: {
                latitude: 52.5333,
                longitude: 13.3833,
                precision: 'exact'
            }
        });
    });

    it('rejects browser-rallar config without usable API and credentials', () => {
        expect(resolveRallarBlackBoxProviderMode('browser-rallar')).toBe('browser-rallar');
        expect(resolveRallarBlackBoxProviderMode('anything')).toBe(
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode
        );

        const config = toRemoteControlConfig({
            bootstrap: resolveRallarBlackBoxBootstrapConfig(
                '?mode=control&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.invalid',
                {},
                ''
            ),
            hasStoredAuthSession: false
        });

        expect(validateRallarBlackBoxProviderConfig(config)).toEqual([
            expect.objectContaining({
                code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID',
                message: 'browser-rallar provider requires a real Rallar API base URL.'
            }),
            expect.objectContaining({
                code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID',
                message: 'browser-rallar provider requires rallar username/password or restoreSession=true.'
            })
        ]);
    });
});
