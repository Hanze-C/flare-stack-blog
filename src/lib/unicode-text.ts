/**
 * Unicode rules for the names people type and compare: Post titles and
 * slugs, Tag and Category names.
 */

// Control (Cc) and format (Cf) characters: NUL, TAB and line breaks, zero
// width spaces and joiners, bidirectional controls, the BOM.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const CONTROL_OR_FORMAT_ALL = /[\p{Cc}\p{Cf}]/gu;

// A zero width joiner inside an emoji sequence, such as the one in a woman
// technologist emoji, is part of the emoji, not a hidden character.
const EMOJI_JOINER =
  /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;

/**
 * Whether `text` holds a control or format character (Unicode Cc or Cf),
 * which are invisible or reorder what is shown. With `emoji`, a zero width
 * joiner inside an emoji sequence is allowed.
 */
export function hasControlCharacter(
  text: string,
  options: { emoji?: boolean } = {},
) {
  const checked = options.emoji ? text.replace(EMOJI_JOINER, "") : text;
  return CONTROL_OR_FORMAT.test(checked);
}

/**
 * `text` without its control and format characters, for an input that cannot
 * hold them: a line break or tab becomes a space, the others are dropped. With
 * `emoji`, a zero width joiner inside an emoji sequence stays.
 */
export function withoutControlCharacters(
  text: string,
  options: { emoji?: boolean } = {},
) {
  const joiners = new Set<number>();
  if (options.emoji) {
    for (const match of text.matchAll(EMOJI_JOINER)) joiners.add(match.index);
  }
  return text.replace(CONTROL_OR_FORMAT_ALL, (character, offset: number) => {
    if (joiners.has(offset)) return character;
    return /\s/.test(character) ? " " : "";
  });
}

/**
 * What two names are compared by when they must be unique: NFKC, so
 * fullwidth letters, ligatures and no-break spaces equal their plain forms,
 * without control and format characters, and with case folded. Upper then
 * lower case folds what lower case alone keeps apart, such as ß and ss.
 *
 * It is only compared, never shown: names and slugs are stored as written.
 * For text of printable ASCII and CJK ideographs alone it is SQLite's
 * `lower()` of the text, which migration 0029 relies on.
 */
export function uniqueKeyOf(text: string) {
  return text
    .normalize("NFKC")
    .replace(CONTROL_OR_FORMAT_ALL, "")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");
}
