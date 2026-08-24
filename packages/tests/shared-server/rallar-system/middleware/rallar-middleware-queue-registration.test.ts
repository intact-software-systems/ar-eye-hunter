import { createRallarMiddlewareQueueRegistration } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar middleware queue registration', () => {
    it('does not expose worker start before every required queue task is registered', () => {
        const registration = createRallarMiddlewareQueueRegistration();

        expect(registration).not.toHaveProperty('start');
        expect(registration).not.toHaveProperty('stop');
    });
});
