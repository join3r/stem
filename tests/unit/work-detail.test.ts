import { describe, expect, it } from 'vitest';
import { workDetail } from '../../src/shared/work-detail';

describe('work detail redaction', () => {
  it('redacts credentials in JSON tool result strings, including quoted values with spaces', () => {
    const output = workDetail('{"password":"fictional password with spaces","nested":{"access_token":"fictional-access","refreshToken":"fictional-refresh"},"message":"Build passed"}');
    expect(JSON.parse(output)).toEqual({ password: '[redacted]', nested: { access_token: '[redacted]', refreshToken: '[redacted]' }, message: 'Build passed' });
    expect(output).not.toContain('fictional');
  });

  it('handles JSON arrays and nested serialized outputs without dropping ordinary fields', () => {
    const input = JSON.stringify([{ result: '{"password":"fictional-secret"}', file: 'release.ipa' }, { headers: { Authorization: 'Basic fictional' } }]);
    const output = JSON.parse(workDetail(input));
    expect(output).toEqual([{ result: '{"password":"[redacted]"}', file: 'release.ipa' }, { headers: '[redacted]' }]);
  });

  it('redacts common plaintext assignments, quoted values, and bearer tokens across lines', () => {
    const input = `Build started\nAPI_KEY=fictional-key\nGITHUB_TOKEN=fictional-github\nAWS_SECRET_ACCESS_KEY=fictional-aws\naccess_token: fictional-access\nrefresh_token='fictional refresh'\npassword="fictional password"\ntoken=fictional-token\nAuthorization: Bearer fictional.bearer/token=\nBuild passed`;
    const output = workDetail(input);
    expect(output).not.toContain('fictional');
    expect(output).toContain("refresh_token='[redacted]'");
    expect(output).toContain('password="[redacted]"');
    expect(output).toContain('Authorization: Bearer [redacted]');
    expect(output).toContain('Build started');
    expect(output).toContain('Build passed');
  });

  it('redacts quoted credential fields inside surrounding text and JSONL', () => {
    const output = workDetail('Response:\n{"password":"fictional\\"password"}\n{"access_token":"fictional-token"}\nDone.');
    expect(output).toBe('Response:\n{"password":"[redacted]"}\n{"access_token":"[redacted]"}\nDone.');
  });

  it('preserves ordinary email prose and secret-free serialized output verbatim', () => {
    for (const input of [
      'Hi Alex,\n\nPlease reset your password using the account settings. The token expires tomorrow.\n\nThanks!',
      '{ "message" : "Build passed", "files": [ "release.ipa" ] }\n',
      'A secret is useful here; password policies remain unchanged.\nThe token count was 42.',
      'Build passed.\n\n  No changes required.  '
    ]) expect(workDetail(input)).toBe(input);
  });

  it('redacts structured inputs and explicitly bounds retained output', () => {
    expect(JSON.parse(workDetail({ command: 'build', apiKey: 'fictional-key', nested: { password: 'fictional-password' } }))).toEqual({
      command: 'build', apiKey: '[redacted]', nested: { password: '[redacted]' }
    });
    expect(workDetail('123456789', 5)).toBe('12345\n[Output truncated]');
  });
});
