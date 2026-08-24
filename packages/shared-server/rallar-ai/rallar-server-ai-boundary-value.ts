import type { RallarAiJsonRequest } from '@shared/rallar-ai/mod.ts';

export type RallarServerAiBoundaryValue = null | boolean | number | string | object | undefined;

export type RallarServerAiValue = RallarAiJsonRequest['schema'];
