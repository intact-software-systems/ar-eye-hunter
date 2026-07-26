import type { ClientStateRepository } from '@shared-server/mod.ts';
import { createRepository } from './factory-capability-provider.ts';

type CreatedRepository = ReturnType<typeof createRepository>;

export function mutateDepth30(repository: ClientStateRepository): void {
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
  const setter13 = () => setter12();
  const setter14 = () => setter13();
  const setter15 = () => setter14();
  const setter16 = () => setter15();
  const setter17 = () => setter16();
  const setter18 = () => setter17();
  const setter19 = () => setter18();
  const setter20 = () => setter19();
  const setter21 = () => setter20();
  const setter22 = () => setter21();
  const setter23 = () => setter22();
  const setter24 = () => setter23();
  const setter25 = () => setter24();
  const setter26 = () => setter25();
  const setter27 = () => setter26();
  const setter28 = () => setter27();
  const setter29 = () => setter28();
  const setter30 = () => setter29();
  setter30();
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
  let created13: CreatedRepository | undefined;
  let created14: CreatedRepository | undefined;
  let created15: CreatedRepository | undefined;
  let created16: CreatedRepository | undefined;
  let created17: CreatedRepository | undefined;
  let created18: CreatedRepository | undefined;
  let created19: CreatedRepository | undefined;
  let created20: CreatedRepository | undefined;
  let created21: CreatedRepository | undefined;
  let created22: CreatedRepository | undefined;
  let created23: CreatedRepository | undefined;
  let created24: CreatedRepository | undefined;
  let created25: CreatedRepository | undefined;
  let created26: CreatedRepository | undefined;
  let created27: CreatedRepository | undefined;
  let created28: CreatedRepository | undefined;
  let created29: CreatedRepository | undefined;
  let created30: CreatedRepository | undefined;
  const setCreated30 = () => {
    created30 = created29;
  };
  const setCreated29 = () => {
    created29 = created28;
  };
  const setCreated28 = () => {
    created28 = created27;
  };
  const setCreated27 = () => {
    created27 = created26;
  };
  const setCreated26 = () => {
    created26 = created25;
  };
  const setCreated25 = () => {
    created25 = created24;
  };
  const setCreated24 = () => {
    created24 = created23;
  };
  const setCreated23 = () => {
    created23 = created22;
  };
  const setCreated22 = () => {
    created22 = created21;
  };
  const setCreated21 = () => {
    created21 = created20;
  };
  const setCreated20 = () => {
    created20 = created19;
  };
  const setCreated19 = () => {
    created19 = created18;
  };
  const setCreated18 = () => {
    created18 = created17;
  };
  const setCreated17 = () => {
    created17 = created16;
  };
  const setCreated16 = () => {
    created16 = created15;
  };
  const setCreated15 = () => {
    created15 = created14;
  };
  const setCreated14 = () => {
    created14 = created13;
  };
  const setCreated13 = () => {
    created13 = created12;
  };
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
  setCreated13();
  setCreated14();
  setCreated15();
  setCreated16();
  setCreated17();
  setCreated18();
  setCreated19();
  setCreated20();
  setCreated21();
  setCreated22();
  setCreated23();
  setCreated24();
  setCreated25();
  setCreated26();
  setCreated27();
  setCreated28();
  setCreated29();
  setCreated30();
  void created30!.updatePrincipal({} as never, 0);
}
