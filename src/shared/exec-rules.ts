export const MAX_COMMAND_ALLOW_RULES = 200;
export const MAX_COMMAND_PREFIX_LENGTH = 200;
export const MAX_COMMAND_REGEX_LENGTH = 200;
export const MAX_REGEX_SEGMENT_LENGTH = 4096;

export function commandRegexError(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return 'Enter a regular expression.';
  if (trimmed.length > MAX_COMMAND_REGEX_LENGTH) {
    return `Regular expressions must be ${MAX_COMMAND_REGEX_LENGTH} characters or fewer.`;
  }
  try {
    new RegExp(`^(?:${trimmed})$`);
    return null;
  } catch {
    return 'Enter a valid regular expression.';
  }
}

export function compileCommandRegex(source: string): RegExp | null {
  const trimmed = source.trim();
  if (commandRegexError(trimmed)) return null;
  return new RegExp(`^(?:${trimmed})$`);
}
