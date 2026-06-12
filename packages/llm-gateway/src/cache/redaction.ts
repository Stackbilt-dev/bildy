const SECRET_PATTERNS = [
  /(sk-[a-zA-Z0-9_-]{10,})/g,
  /(gsk_[a-zA-Z0-9_-]{10,})/g,
  /(csk-[a-zA-Z0-9_-]{10,})/g,
  /(AKIA[0-9A-Z]{16})/g,
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), input);
}
