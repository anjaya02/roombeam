// Room codes. Shared verbatim between server and browser — the server must
// validate exactly what the client generates, and a second copy of these rules
// would drift.
//
// Crockford base32: no I, L, O or U. The first three are excluded because a
// code that has to survive being read aloud across a room, or squinted at on a
// projector, cannot contain characters that look like 1 and 0. U is excluded so
// that no random draw can spell an unfortunate word.

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 5;

// 32^5 = 33.5 million. Collisions do not matter for correctness — a code is
// only ever live while someone is in the room — but they matter for privacy,
// and at any plausible concurrent-room count the odds of a guess landing on a
// live room stay negligible.

/**
 * Fold the ambiguous characters a human might type onto the ones we emit.
 * Returns null if the input cannot be a code.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;

  const folded = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  if (folded.length !== CODE_LENGTH) return null;
  for (const ch of folded) if (!ALPHABET.includes(ch)) return null;
  return folded;
}

/**
 * A fresh code from a CSPRNG. Rejection sampling rather than `% 32` so the
 * distribution is exactly uniform; 256 is a multiple of 32 so nothing is ever
 * actually rejected, but the guard documents the requirement.
 * @param {(n: number) => Uint8Array} randomBytes
 */
export function generateCode(randomBytes) {
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Insert a separator for display only. Never store or transmit this form. */
export const formatCode = (code) => `${code.slice(0, 2)}-${code.slice(2)}`;
