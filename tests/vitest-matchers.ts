import { expect } from 'vitest';

expect.extend({
  toStartWith(actual: string, expected: string) {
    return { pass: actual.startsWith(expected), message: () => `expected ${JSON.stringify(actual)} ${this.isNot ? 'not ' : ''}to start with ${JSON.stringify(expected)}` };
  },
  toEndWith(actual: string, expected: string) {
    return { pass: actual.endsWith(expected), message: () => `expected ${JSON.stringify(actual)} ${this.isNot ? 'not ' : ''}to end with ${JSON.stringify(expected)}` };
  },
  toBeFunction(actual: unknown) {
    return { pass: typeof actual === 'function', message: () => `expected ${String(actual)} ${this.isNot ? 'not ' : ''}to be a function` };
  },
});

declare module 'vitest' {
  interface Assertion<T = any, R = any> {
    toStartWith(expected: string): T;
    toEndWith(expected: string): T;
    toBeFunction(): T;
  }
}
