import type { ClientStateRepository } from '@shared-server/mod.ts';
import { createRepository } from './factory-capability-provider.ts';

type CreatedRepository = ReturnType<typeof createRepository>;

export function mutateDepth12(repository: ClientStateRepository): void {
    let invoke:
        | ClientStateRepository['insertPrincipal']
        | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
    const setter0 = () => {
        invoke = repository.insertPrincipal;
    };
    const setter1 = () => setter0();
    const setter2 = () => setter1();
    const setter3 = () => setter2();
    const setter4 = () => setter3();
    const setter5 = () => setter4();
    const setter6 = () => setter5();
    const setter7 = () => setter6();
    const setter8 = () => setter7();
    const setter9 = () => setter8();
    const setter10 = () => setter9();
    const setter11 = () => setter10();
    const setter12 = () => setter11();
    setter12();
    void invoke({} as never);

    let created1: CreatedRepository | undefined;
    let created2: CreatedRepository | undefined;
    let created3: CreatedRepository | undefined;
    let created4: CreatedRepository | undefined;
    let created5: CreatedRepository | undefined;
    let created6: CreatedRepository | undefined;
    let created7: CreatedRepository | undefined;
    let created8: CreatedRepository | undefined;
    let created9: CreatedRepository | undefined;
    let created10: CreatedRepository | undefined;
    let created11: CreatedRepository | undefined;
    let created12: CreatedRepository | undefined;
    const setCreated12 = () => {
        created12 = created11;
    };
    const setCreated11 = () => {
        created11 = created10;
    };
    const setCreated10 = () => {
        created10 = created9;
    };
    const setCreated9 = () => {
        created9 = created8;
    };
    const setCreated8 = () => {
        created8 = created7;
    };
    const setCreated7 = () => {
        created7 = created6;
    };
    const setCreated6 = () => {
        created6 = created5;
    };
    const setCreated5 = () => {
        created5 = created4;
    };
    const setCreated4 = () => {
        created4 = created3;
    };
    const setCreated3 = () => {
        created3 = created2;
    };
    const setCreated2 = () => {
        created2 = created1;
    };
    const setCreated1 = () => {
        created1 = created0;
    };
    const created0 = createRepository();
    setCreated1();
    setCreated2();
    setCreated3();
    setCreated4();
    setCreated5();
    setCreated6();
    setCreated7();
    setCreated8();
    setCreated9();
    setCreated10();
    setCreated11();
    setCreated12();
    void created12!.updatePrincipal({} as never, 0);
}
