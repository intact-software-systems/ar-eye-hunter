import { createRallarMiddlewareQueueConstruction } from '@shared-server/rallar-system/middleware/rallar-middleware-queue-construction.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar middleware queue construction', () => {
    it('does not expose worker start before every required queue task is registered', () => {
        const queueConstruction = createRallarMiddlewareQueueConstruction();
        const registration = queueConstruction.beginTaskRegistration();

        expect(queueConstruction).not.toHaveProperty('start');
        expect(queueConstruction).not.toHaveProperty('stop');
        expect(registration).not.toHaveProperty('start');
        expect(registration.queueTasks).not.toHaveProperty('start');
        expect(() => registration.complete()).toThrow(
            'Rallar middleware queue task registration is incomplete'
        );
    });
});
