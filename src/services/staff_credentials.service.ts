import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export function hashStaffPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyStaffPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, storedHex] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !storedHex || !/^[a-f\d]{128}$/i.test(storedHex)) return false;
  const actual = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(storedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Minimum staff password length, shared by sign-in and account management. */
export const STAFF_PASSWORD_MIN_LENGTH = 14;

// A fixed hash to compare against when the account does not exist, so an
// unknown username costs the same scrypt time as a wrong password.
const DUMMY_HASH = hashStaffPassword('prep404-timing-equaliser-not-a-real-password');

/** Spend the same work as a real check, for unknown or disabled accounts. */
export function burnStaffPasswordCheck(password: string): void {
  verifyStaffPassword(password, DUMMY_HASH);
}
