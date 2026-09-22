import type { RallarBlackBoxTestCommandKind } from '../rallar-black-box-test-contracts.ts';
import { hasCrdtCommandKind } from './distributed-recipe-command-preview.ts';
import type { DistributedRecipePreflightServiceBadge } from './distributed-recipe-preflight-contracts.ts';

export function toPreflightServiceBadges(
    commandKinds: readonly RallarBlackBoxTestCommandKind[],
    liveServiceRequirements: readonly string[]
): readonly DistributedRecipePreflightServiceBadge[] {
    const kinds = new Set(commandKinds);
    return [
        { label: 'control server', tone: 'active' },
        { label: 'browser agents', tone: 'active' },
        ...(liveServiceRequirements.length > 0 ? [{ label: 'runtime evidence', tone: 'warn' }] : []),
        ...(kinds.has('http.request') ? [{ label: 'HTTP/API', tone: 'warn' }] : []),
        ...(kinds.has('ws.open') || kinds.has('ws.send') || kinds.has('ws.close')
            ? [{ label: 'WebSocket', tone: 'warn' }]
            : []),
        ...(kinds.has('rtc.connect') ? [{ label: 'Rallar auth/signaling', tone: 'warn' }] : []),
        ...(kinds.has('rtc.send') || kinds.has('rtc.stream') ? [{ label: 'RTC peers', tone: 'warn' }] : []),
        ...(hasCrdtCommandKind(commandKinds) ? [{ label: 'CRDT', tone: 'warn' }] : []),
        ...(kinds.has('loop') ? [{ label: 'looped traffic', tone: 'active' }] : []),
        ...(kinds.has('parallel') ? [{ label: 'parallel groups', tone: 'active' }] : [])
    ];
}

export function toPreflightCompatibilityWarnings(
    commandKinds: readonly RallarBlackBoxTestCommandKind[],
    liveServiceRequirements: readonly string[]
): readonly string[] {
    const kinds = new Set(commandKinds);
    return [
        ...(liveServiceRequirements.length > 0
            ? ['Recipe requires live runtime evidence or live services from the selected browser agents.']
            : []),
        ...(kinds.has('rtc.connect') || kinds.has('rtc.send') || kinds.has('rtc.stream')
            ? [
                'RTC recipes require real Rallar signaling, compatible group membership, ' +
                'and at least one peer for delivery checks.'
            ]
            : []),
        ...(kinds.has('ws.open') || kinds.has('ws.send')
            ? [
                'WebSocket recipes require an open or openable socket for every target agent ' +
                'that sends WS traffic.'
            ]
            : []),
        ...(kinds.has('http.request')
            ? ['HTTP recipes can require access tokens and reachable Rallar Server endpoints.']
            : []),
        ...(hasCrdtCommandKind(commandKinds)
            ? [
                'CRDT recipes require browser agents with the Rallar CRDT runtime ' +
                'and requested CRDT transport support.'
            ]
            : [])
    ];
}
