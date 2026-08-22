import type { RallarBlackBoxTestHttpRequestCommand } from '@shared-test/rallar-bb-test/types.ts';

export type RallarServerRestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type RallarServerResponseBodyMode = 'auto' | 'json' | 'text' | 'none';

export interface RallarServerEndpointPreset {
    readonly presetId: string;
    readonly tag: string;
    readonly label: string;
    readonly method: RallarServerRestMethod;
    readonly pathTemplate: string;
    readonly requiresAuth: boolean;
    readonly body?: RallarBlackBoxTestHttpRequestCommand['request']['body'];
    readonly responseBodyMode?: RallarServerResponseBodyMode;
}
