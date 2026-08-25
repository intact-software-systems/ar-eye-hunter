import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import { json } from '../../shared/json-presentation.ts';
import type { QuickRallarValues } from './quick-rallar-contracts.ts';

export const QUICK_RALLAR_DEFAULT_VALUES: QuickRallarValues = {
    transport: 'ws',
    typeId: 'room.manual.message',
    topicId: 'room.manual.message',
    contextId: '',
    resourceId: '',
    payloadText: json({
        text: 'hello from quick Rallar test',
        seq: 1
    }),
    timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
};
