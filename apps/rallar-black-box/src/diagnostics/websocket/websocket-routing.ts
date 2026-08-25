import type { RallarBlackBoxTestConfig } from '@shared-test/rallar-bb-test/types.ts';
import { stringValue } from '../../legacy/shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../runtime-store.ts';
import { isWebSocketJsonObject } from './normalize-websocket-json-value.ts';
import type {
    WebSocketCommandCenterValues,
    WebSocketDiagnostic,
    WebSocketJsonObject,
    WebSocketJsonValue,
    WebSocketRoutePreview
} from './websocket-contracts.ts';
import { DEFAULT_WEBSOCKET_PAYLOAD_PRESET_ID, webSocketPayloadPresetById } from './websocket-presets.ts';
import { defaultWebSocketApiUrl } from './websocket-url-routing.ts';

export interface WebSocketDefaultValues {
    readonly apiBaseUrl: string;
    readonly applicationId: string;
    readonly workspaceId: string;
    readonly groupId: string;
    readonly contextId: string;
}

export interface WebSocketRoutePreviewInput {
    readonly values: WebSocketCommandCenterValues;
    readonly diagnostics: WebSocketDiagnostic;
    readonly providerMode: string;
    readonly browserStatus: RallarBrowserStatusSummary;
}

interface WebSocketRouteDestination {
    readonly destination: string;
    readonly destinationDetail: string;
}

interface WebSocketRouteTransport {
    readonly transport: string;
    readonly transportDetail: string;
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
    bootstrap: RallarBlackBoxBootstrapConfig
): WebSocketDefaultValues {
    const groupId = stringValue(globalValues?.roomId) ??
        stringValue(config?.roomId) ??
        bootstrap.roomId;
    return {
        apiBaseUrl: globalValues?.apiBaseUrl ??
            config?.apiBaseUrl ??
            bootstrap.apiBaseUrl,
        applicationId: globalValues?.applicationId ??
            stringValue(config?.rallar?.applicationId) ??
            'rallar-black-box',
        workspaceId: globalValues?.workspaceId ??
            stringValue(config?.rallar?.workspaceId) ??
            'default',
        groupId,
        contextId: groupId || 'all'
    };
}

export function webSocketSendData(
    values: WebSocketCommandCenterValues,
    payload: WebSocketJsonValue
): WebSocketJsonObject {
    const payloadRecord = isWebSocketJsonObject(payload) ? payload : {};
    const hasTypedFields = [
        'payload',
        'data',
        'typeId',
        'topicId',
        'roomId',
        'groupId',
        'scope',
        'contextId',
        'resourceId'
    ].some((key) => key in payloadRecord);
    const base: WebSocketJsonObject = hasTypedFields ? payloadRecord : { payload };
    const wsScope = base.scope === 'room' || base.scope === 'all' || base.scope === 'world'
        ? base.scope
        : values.wsScope;
    const explicitGroupId = stringValue(base.roomId) ?? stringValue(base.groupId);
    const groupId = explicitGroupId ?? (wsScope === 'room' ? values.groupId : '');
    const typeId = stringValue(base.typeId) ?? values.typeId;
    const topicId = stringValue(base.topicId) ?? values.topicId ?? typeId;
    const contextId = stringValue(base.contextId) ?? values.contextId ?? groupId ?? wsScope;

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
            : {})
    };
}

export function webSocketRoutePreview(
    input: WebSocketRoutePreviewInput
): WebSocketRoutePreview {
    const { values, diagnostics, providerMode, browserStatus } = input;
    const groupId = values.groupId.trim();
    const typeId = values.typeId.trim() || '-';
    const topicId = values.topicId.trim() || '*';
    const contextId = values.contextId.trim() || values.wsScope;
    const destination = computeWebSocketRouteDestination(values, groupId);
    const transport = computeWebSocketRouteTransport(input);

    return {
        ...destination,
        selector: `${topicId} / ${typeId}`,
        selectorDetail: `Context ${contextId}`,
        ...transport,
        sendLabel: computeWebSocketSendLabel(values.wsScope, groupId)
    };
}

function computeWebSocketRouteDestination(
    values: WebSocketCommandCenterValues,
    groupId: string
): WebSocketRouteDestination {
    if (values.wsScope === 'room') {
        return groupId
            ? {
                destination: `Group ${groupId}`,
                destinationDetail: `Application ${values.applicationId || '-'} / workspace ${values.workspaceId || '-'}`
            }
            : {
                destination: 'No group selected',
                destinationDetail: 'Room-scoped messages need a Group before send.'
            };
    }

    return values.wsScope === 'all'
        ? { destination: 'All WS subscribers', destinationDetail: 'Group is ignored for this send.' }
        : { destination: 'World scope', destinationDetail: 'Uses Rallar world scope; Group is ignored.' };
}

function computeWebSocketRouteTransport(input: WebSocketRoutePreviewInput): WebSocketRouteTransport {
    const { values, diagnostics, providerMode, browserStatus } = input;
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
        transport,
        transportDetail
    };
}

function computeWebSocketSendLabel(
    wsScope: WebSocketCommandCenterValues['wsScope'],
    groupId: string
): string {
    if (wsScope === 'room') {
        return groupId ? `Send JSON to group ${groupId}` : 'Send JSON to group';
    }
    return wsScope === 'all' ? 'Send JSON to all' : 'Send JSON to world';
}
