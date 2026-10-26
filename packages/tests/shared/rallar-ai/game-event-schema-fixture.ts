export const GAME_EVENT_SCHEMA_FIXTURE = {
    type: 'object',
    required: ['kind', 'amount'],
    properties: {
        kind: { type: 'string', enum: ['spawn', 'reward'] },
        amount: { type: 'integer', minimum: 1 }
    },
    additionalProperties: false
} as const;
