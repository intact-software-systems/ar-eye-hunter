import type { ClientStateRepository } from '@shared-server/mod.ts';

export function invokeDeepWriteChain(repository: ClientStateRepository): void {
  let invoke:
    | ClientStateRepository['insertPrincipal']
    | ClientStateRepository['readSnapshot'] = repository.readSnapshot;
  levelOne();
  void invoke({} as never);

  function levelOne(): void {
    levelTwo();
  }
  function levelTwo(): void {
    levelThree();
  }
  function levelThree(): void {
    levelFour();
  }
  function levelFour(): void {
    levelFive();
  }
  function levelFive(): void {
    levelSix();
  }
  function levelSix(): void {
    levelSeven();
  }
  function levelSeven(): void {
    levelEight();
  }
  function levelEight(): void {
    levelNine();
  }
  function levelNine(): void {
    levelTen();
  }
  function levelTen(): void {
    invoke = repository.insertPrincipal;
  }
}
