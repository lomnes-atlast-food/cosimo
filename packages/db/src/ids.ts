import { monotonicFactory } from "ulid";

const gen = monotonicFactory();
export function newId(): string {
  return gen();
}
