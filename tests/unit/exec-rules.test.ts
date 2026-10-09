import { describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_REGEX_LENGTH,
  compileCommandRegex,
  commandRegexError
} from '../../src/shared/exec-rules';

describe('command regex rules', () => {
  it('implicitly anchors the whole segment', () => {
    const rule = compileCommandRegex('kubectl(?:\\s+.*)?\\s+get(?:\\s+.*)?');

    expect(rule?.test('kubectl --kubeconfig "" get pods')).toBe(true);
    expect(rule?.test('echo kubectl get pods')).toBe(false);
    expect(rule?.test('kubectl get pods trailing')).toBe(true);
  });

  it('reports invalid and oversized expressions', () => {
    expect(commandRegexError('(')).toBeTruthy();
    expect(commandRegexError('x'.repeat(MAX_COMMAND_REGEX_LENGTH + 1))).toBeTruthy();
    expect(commandRegexError('kubectl get')).toBeNull();
  });
});
