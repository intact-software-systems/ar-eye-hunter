import { describe, expect, it } from 'vitest';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { createRallarMiddleware } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import type { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';

describe('createRallarMiddleware', () => {
    it('constructs queuebox runtime services around supplied repositories', () => {
        const inbox = new InMemoryQueueBox();
        const outbox = new InMemoryQueueBox();
        const clientsRepository = {} as ClientStateRepository;
        const groupsRepository = {} as GroupStateRepository;
        const runtime = createRallarMiddleware({
            inbox,
            outbox,
            wsRuntimeName: 'server-1',
            resilience: {
                inbox: createResilience(),
                outbox: createResilience(),
            },
            clientsRepository,
            groupsRepository,
        });

        expect(runtime.wsQBoxServerService).toBeInstanceOf(WsQueueBoxServerService);
        expect(runtime.wsQBoxServerService.inbox).toBe(inbox);
        expect(runtime.wsQBoxServerService.outbox).toBe(outbox);
        expect(runtime.wsQBoxServerService.name).toBe('server-1');
        expect(runtime.clientsRepository).toBe(clientsRepository);
        expect(runtime.groupsRepository).toBe(groupsRepository);
        expect(runtime.qboxEngine).toBeDefined();
    });
});

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}
