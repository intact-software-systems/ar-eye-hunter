import { describe, expect, it } from 'vitest';
import {
    bootstrapFleetMetadata,
    remoteControlConfig,
    resolveRallarBlackBoxBootstrapConfig,
    validateRallarBlackBoxProviderConfig
} from '../../../packages/shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { parseRallarBlackBoxProviderMode, RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../packages/shared-test/rallar-bb-test/client-defaults.ts';

describe('browser control-agent bootstrap config', () => {
    it('parses URL params into a browser-rallar control-agent bootstrap config', () => {
        const config = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&controlUrl=wss%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-1&agentId=agent-1&apiBaseUrl=https%3A%2F%2Fapi.example.test&roomId=room-1&rallarUsername=alice&rallarPassword=secret&rallarRegister=1&fleetTags=canary%2Crtc',
            {}
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

    it('builds the exact remote-control runtime config used by browser agents', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&controlUrl=wss%3A%2F%2Fcontrol.example.test%2Fcontrol&runId=run-2&agentId=agent-2&apiBaseUrl=https%3A%2F%2Fapi.example.test&applicationId=rallar-server&workspaceId=default&roomId=room-2&actor=agent-2&sessionId=session-2&rallarUsername=bob&rallarPassword=secret&rallarLeaveRoomOnClose=0',
            {}
        );

        const runtimeConfig = remoteControlConfig(bootstrap, 7);

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
            {}
        );

        const runtimeConfig = remoteControlConfig(bootstrap, 1);

        expect(bootstrap.rallarRegister).toBe('if-needed');
        expect(runtimeConfig.rallar?.register).toBe('if-needed');
    });

    it('passes per-tab auth storage through bootstrap without putting tickets in runtime config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&autoConnect=1&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.test&rallarAuthStorage=session&actor=alice&sessionId=agent-session&rallarRestoreSession=1',
            {},
            '#agentSessionTicket=one-time-ticket'
        );

        const runtimeConfig = remoteControlConfig(bootstrap, 3);

        expect(bootstrap.rallarAuthStorage).toBe('session');
        expect(bootstrap.rallarAgentSessionTicket).toBe('one-time-ticket');
        expect(runtimeConfig.rallar?.restoreSession).toBe(true);
        expect(JSON.stringify(runtimeConfig)).not.toContain('one-time-ticket');
    });

    it('preserves explicit fleet location metadata in remote-control runtime config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&fleetRegion=eu-north&fleetProvider=hetzner&fleetDatacenter=fsn1&fleetLatitude=52.5333&fleetLongitude=13.3833&fleetLocationLabel=fsn1%20operator%20rack',
            {}
        );
        const runtimeConfig = remoteControlConfig(bootstrap, 1);

        expect(bootstrap).toMatchObject({
            fleetLatitude: 52.5333,
            fleetLongitude: 13.3833,
            fleetLocationLabel: 'fsn1 operator rack'
        });
        expect(bootstrapFleetMetadata(bootstrap)).toMatchObject({
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
        expect(parseRallarBlackBoxProviderMode('browser-rallar')).toBe('browser-rallar');
        expect(parseRallarBlackBoxProviderMode('anything')).toBe(
            RALLAR_BLACK_BOX_CLIENT_DEFAULTS.providerMode
        );

        const config = remoteControlConfig(
            resolveRallarBlackBoxBootstrapConfig(
                '?mode=control&provider=browser-rallar&apiBaseUrl=https%3A%2F%2Fapi.example.invalid',
                {}
            ),
            1
        );

        expect(validateRallarBlackBoxProviderConfig(config)).toMatchObject({
            code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID'
        });
    });
});
