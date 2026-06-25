// Minimal Jest-compatible shim over Node's built-in test runner.
//
// The test bodies are written in Jest style (`expect().toBe()`, `toHaveLength`,
// `beforeAll`, etc.). Node's `node:test` runner supplies `describe`/`test` but
// no `expect`, and names its hooks `before`/`after`. This module bridges the gap
// so the existing tests run unchanged under `node --test`.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

function buildMatchers(actual, negate) {
  const check = (pass, message) => {
    assert.ok(negate ? !pass : pass, message);
  };
  return {
    toBe(expected) {
      check(Object.is(actual, expected),
        `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}to be ${JSON.stringify(expected)}`);
    },
    toHaveLength(length) {
      const actualLength = actual == null ? undefined : actual.length;
      check(actualLength === length,
        `expected length ${actualLength} ${negate ? 'not ' : ''}to be ${length}`);
    },
    toContain(item) {
      check(actual != null && actual.includes(item),
        `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}to contain ${JSON.stringify(item)}`);
    },
    toMatch(regex) {
      check(regex.test(actual),
        `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}to match ${regex}`);
    },
    toBeGreaterThan(n) {
      check(actual > n, `expected ${actual} ${negate ? 'not ' : ''}to be greater than ${n}`);
    },
    toBeNull() {
      check(actual === null, `expected ${JSON.stringify(actual)} ${negate ? 'not ' : ''}to be null`);
    },
  };
}

export function expect(actual) {
  const matchers = buildMatchers(actual, false);
  matchers.not = buildMatchers(actual, true);
  return matchers;
}

// Jest's lifecycle hook names map onto node:test's before/after.
export const beforeAll = before;
export const afterAll = after;

export { describe, test };
