const MIN_PASSWORD_CHARACTERS = 12;
const MAX_PASSWORD_CHARACTERS = 256;

export function accountPasswordPolicyError(password: string): string | null {
  const characters = Array.from(password).length;
  if (characters < MIN_PASSWORD_CHARACTERS) {
    return `Use at least ${MIN_PASSWORD_CHARACTERS} characters.`;
  }
  if (characters > MAX_PASSWORD_CHARACTERS) {
    return `Use no more than ${MAX_PASSWORD_CHARACTERS} characters.`;
  }
  return null;
}

export function requireValidAccountPassword(password: string): void {
  const error = accountPasswordPolicyError(password);
  if (error !== null) throw new Error(error);
}
