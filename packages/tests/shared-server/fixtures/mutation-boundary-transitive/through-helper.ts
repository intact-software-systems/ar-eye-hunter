import { cycle } from './cycle.ts';

export function connectThroughHelper(): void {
  cycle();
  repository.connectSession({});
}

const repository = {
  connectSession(_input: object): void {
  },
};
