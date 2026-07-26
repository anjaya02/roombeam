// Text arriving from a peer — a device name, a filename — is untrusted input
// that some other device is about to render or write to disk. Both the server
// and the client need the same rules, so they live here.
//
// Written as explicit code-point tests rather than a regular expression: the
// interesting characters are invisible, and a character class full of invisible
// characters is a class nobody can review.

const C0_END = 0x1f;
const DEL = 0x7f;
const C1_START = 0x80;
const C1_END = 0x9f;
const LRM = 0x200e;
const RLM = 0x200f;
const BIDI_EMBED_START = 0x202a; // LRE RLE PDF LRO RLO
const BIDI_EMBED_END = 0x202e;
const BIDI_ISOLATE_START = 0x2066; // LRI RLI FSI PDI
const BIDI_ISOLATE_END = 0x2069;
const BOM = 0xfeff;
const OBJECT_REPLACEMENT = 0xfffc;

/**
 * Would this code point be invisible, or able to reorder the characters around
 * it? The bidi controls are the dangerous ones: an override lets
 * `invoice.txt<RLO>exe.gpj` render as `invoice.txtjpg.exe` reversed — the file
 * appears to be a .jpg and is not.
 */
function isDisplayable(c) {
  if (c <= C0_END || c === DEL) return false;
  if (c >= C1_START && c <= C1_END) return false;
  if (c === LRM || c === RLM) return false;
  if (c >= BIDI_EMBED_START && c <= BIDI_EMBED_END) return false;
  if (c >= BIDI_ISOLATE_START && c <= BIDI_ISOLATE_END) return false;
  if (c === BOM || c === OBJECT_REPLACEMENT) return false;
  return true;
}

/**
 * Strip everything invisible or reordering, collapse runs of whitespace, and
 * clamp the length. Iterates by code point so astral characters (emoji in a
 * device name) survive intact instead of being cut in half into a lone
 * surrogate.
 *
 * @param {unknown} raw
 * @param {number} max characters to keep
 * @param {string} fallback returned when nothing usable is left
 */
export function sanitizeText(raw, max = 40, fallback = '') {
  if (typeof raw !== 'string') return fallback;

  let out = '';
  for (const ch of raw) {
    if (!isDisplayable(ch.codePointAt(0))) continue;
    out += ch;
    if (out.length >= max) break;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out || fallback;
}

// Windows refuses these as filenames whatever the extension, and a receiver
// that silently fails to save is worse than one that saves under a nudged name.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME = 180;

/**
 * A filename we are willing to write to disk.
 *
 * The path separators matter most: without stripping them, a peer can name a
 * file `../../autorun.inf` and, on a tier that writes where it is told, land it
 * somewhere it was never offered.
 *
 * @param {unknown} raw
 */
export function safeFileName(raw) {
  // Generous at this stage: the length clamp comes later, and clipping here
  // would cut the extension off a long name before it can be preserved.
  let name = sanitizeText(raw, 1024, '');

  // Keep only the last path segment. Replacing separators in place would leave
  // `../../autorun.inf` as a legible but nonsensical `__.._autorun.inf`; a peer
  // is offering a file, not a location, so the directory part is simply not ours.
  const segments = name.split(/[/\\]+/).filter((part) => part && part !== '.' && part !== '..');
  name = segments.length ? segments[segments.length - 1] : '';

  name = name
    .replace(/[:*?"<>|]/g, '_')   // rejected by Windows, awkward everywhere else
    .replace(/^\.+/, '_')         // a leading dot hides the file on Unix
    .replace(/[. ]+$/, '');       // Windows drops these silently, so do it visibly

  if (!name) return 'received-file';
  if (RESERVED.test(name)) name = `_${name}`;

  // Truncate around the extension rather than through it. A file that arrives
  // as `presentation-final-v.pptx` still opens; `presentation-final-v2.pp`
  // does not.
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }

  return name;
}

/**
 * The extension a user will actually get, for display next to the filename.
 * Surfacing this is the mitigation for extension spoofing: whatever the name
 * claims, this is what the operating system will act on.
 */
export function trueExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Extensions that execute on at least one of the platforms we target. */
const EXECUTABLE = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'lnk', 'reg', 'vbs', 'vbe',
  'js', 'jse', 'jar', 'ps1', 'psm1', 'wsf', 'wsh', 'hta', 'msc', 'apk', 'app', 'dmg',
  'pkg', 'command', 'sh', 'bash', 'zsh', 'run', 'deb', 'rpm', 'appimage', 'scpt', 'osa',
]);

export const isExecutable = (name) => EXECUTABLE.has(trueExtension(name));
