import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxTestConfig } from '@shared-test/rallar-bb-test/types.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { recordValue as optionalRecord } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../shell/rallar-browser-status.ts';
import type { AuthCommandCenterTicket } from '../shared/auth-command-center-ticket.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketRoutePreview,
} from './websocket-contracts.ts';
import {
    DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID,
    webSocketPayloadPresetById,
} from './websocket-presets.ts';

export function defaultWebSocketApiUrl(apiBaseUrl: string): string {
    try {
        const url = new URL(apiBaseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/api/ws/{auth.sessionId}';
        url.search = 'ticket={auth.wsTicket}';
        return url.toString();
    } catch {
        return 'ws://localhost:8080/api/ws/{auth.sessionId}?ticket={auth.wsTicket}';
    }
}

export function resolveWebSocketUrlTemplate(
    template: string,
    apiBaseUrl: string,
    authSession: AuthSession | undefined,
    ticket: AuthCommandCenterTicket | undefined,
): string {
    const wsBaseUrl = (() => {
        try {
            const url = new URL(apiBaseUrl);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.pathname = '';
            url.search = '';
            url.hash = '';
            return url.toString().replace(/\/$/, '');
        } catch {
            return 'ws://localhost:8080';
        }
    })();
    return template
        .replaceAll(
            '{auth.sessionId}',
            encodeURIComponent(
                authSession?.sessionId ?? ticket?.sessionId ?? '',
            ),
        )
        .replaceAll('{auth.wsTicket}', encodeURIComponent(ticket?.ticket ?? ''))
        .replaceAll('{config.wsBaseUrl}', wsBaseUrl);
}

export function defaultWebSocketTypeId(): string {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.typeId ?? 'room.manual.message'
    );
}

export function defaultWebSocketTopicId(): string {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.topicId ?? defaultWebSocketTypeId()
    );
}

export function defaultWebSocketScope(): WebSocketCommandCenterValues['wsScope'] {
    return (
        webSocketPayloadPresetById(DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID).values
            ?.wsScope ?? 'room'
    );
}

export function defaultWebSocketValuesFromContext(
    globalValues: CommandCenterGlobalValues | undefined,
    config: RallarBlackBoxTestConfig | undefined,
    bootstrap: RallarBlackBoxBootstrapConfig,
): Pick<
    WebSocketCommandCenterValues,
    'apiBaseUrl' | 'applicationId' | 'workspaceId' | 'groupId' | 'contextId'
> {
    const groupId =
        stringValue(globalValues?.roomId) ??
        stringValue(config?.roomId) ??
        bootstrap.roomId;
    return {
        apiBaseUrl:
            globalValues?.apiBaseUrl ??
            config?.apiBaseUrl ??
            bootstrap.apiBaseUrl,
        applicationId:
            globalValues?.applicationId ??
            stringValue(config?.rallar?.applicationId) ??
            'rallar-black-box',
        workspaceId:
            globalValues?.workspaceId ??
            stringValue(config?.rallar?.workspaceId) ??
            'default',
        groupId,
        contextId: groupId || 'all',
    };
}

export function webSocketSendData(
    values: WebSocketCommandCenterValues,
    payload: unknown,
): unknown {
    const payloadRecord = optionalRecord(payload);
    const hasTypedFields = [
        'payload',
        'data',
        'typeId',
        'topicId',
        'roomId',
        'groupId',
        'scope',
        'contextId',
        'resourceId',
    ].some((key) => key in payloadRecord);
    const base = hasTypedFields ? payloadRecord : { payload };
    const wsScope =
        base.scope === 'room' || base.scope === 'all' || base.scope === 'world'
            ? base.scope
            : values.wsScope;
    const explicitGroupId =
        stringValue(base.roomId) ?? stringValue(base.groupId);
    const groupId =
        explicitGroupId ?? (wsScope === 'room' ? values.groupId : '');
    const typeId = stringValue(base.typeId) ?? values.typeId;
    const topicId = stringValue(base.topicId) ?? values.topicId ?? typeId;
    const contextId =
        stringValue(base.contextId) ?? values.contextId ?? groupId ?? wsScope;

    return {
        ...base,
        applicationId: stringValue(base.applicationId) ?? values.applicationId,
        workspaceId: stringValue(base.workspaceId) ?? values.workspaceId,
        ...(groupId ? { roomId: groupId, groupId } : {}),
        scope: wsScope,
        typeId,
        topicId,
        contextId,
        ...(values.resourceId && !('resourceId' in base)
            ? { resourceId: values.resourceId }
            : {}),
    };
}

export function webSocketRoutePreview(
    input: Readonly<{
        values: WebSocketCommandCenterValues;
        diagnostics: WebSocketDiagnostic;
        providerMode: string;
        browserStatus: RallarBrowserStatusSummary;
    }>,
): WebSocketRoutePreview {
    const { values, diagnostics, providerMode, browserStatus } = input;
    const groupId = values.groupId.trim();
    const typeId = values.typeId.trim() || '-';
    const topicId = values.topicId.trim() || '*';
    const contextId = values.contextId.trim() || values.wsScope;
    const destination =
        values.wsScope === 'room'
            ? groupId
                ? `Group ${groupId}`
                : 'No group selected'
            : values.wsScope === 'all'
              ? 'All WS subscribers'
              : 'World scope';
    const destinationDetail =
        values.wsScope === 'room'
            ? groupId
                ? `Application ${values.applicationId || '-'} / workspace ${values.workspaceId || '-'}`
                : 'Room-scoped messages need a Group before send.'
            : values.wsScope === 'all'
              ? 'Group is ignored for this send.'
              : 'Uses Rallar world scope; Group is ignored.';
    const usesRallarAppWebSocket = providerMode === 'browser-rallar';
    const transport = usesRallarAppWebSocket
        ? 'Rallar app WS'
        : diagnostics.status === 'open'
          ? 'Raw WebSocket'
          : providerMode === 'simulated'
            ? 'Simulated WebSocket'
            : 'No open WS';
    const transportDetail = usesRallarAppWebSocket
        ? browserStatus.signalingLabel === 'open'
            ? `Uses open Rallar signaling for ${values.connection}`
            : `Connects Rallar signaling for ${values.connection}`
        : `Connection ${values.connection}`;

    return {
        destination,
        destinationDetail,
        selector: `${topicId} / ${typeId}`,
        selectorDetail: `Context ${contextId}`,
        transport,
        transportDetail,
        sendLabel:
            values.wsScope === 'room'
                ? groupId
                    ? `Send JSON to group ${groupId}`
                    : 'Send JSON to group'
                : values.wsScope === 'all'
                  ? 'Send JSON to all'
                  : 'Send JSON to world',
    };
}
