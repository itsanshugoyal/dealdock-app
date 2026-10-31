/**
 * Speech-to-text vendors disagree on language codes: ElevenLabs Scribe
 * returns ISO 639-3 ("hin", "eng"), Whisper-style servers return names
 * ("hindi"). BCP-47 uses the shortest ISO 639 code, so normalize to that.
 */
const ISO_639_3_TO_1: Record<string, string> = {
  hin: "hi", eng: "en", mar: "mr", ben: "bn", tam: "ta", tel: "te", guj: "gu", kan: "kn", mal: "ml",
  pan: "pa", urd: "ur", ori: "or", asm: "as", nep: "ne", san: "sa", ara: "ar", spa: "es", fra: "fr",
  deu: "de", por: "pt", ita: "it", rus: "ru", jpn: "ja", kor: "ko", zho: "zh", cmn: "zh", nld: "nl",
  tur: "tr", ind: "id", msa: "ms", zsm: "ms", tha: "th", vie: "vi", pol: "pl", ukr: "uk", swe: "sv",
  fas: "fa", pes: "fa", heb: "he", ell: "el",
};

const NAMES: Record<string, string> = {
  english: "en", hindi: "hi", marathi: "mr", bengali: "bn", tamil: "ta", telugu: "te", gujarati: "gu",
  kannada: "kn", malayalam: "ml", punjabi: "pa", urdu: "ur", arabic: "ar", spanish: "es", french: "fr",
  german: "de", portuguese: "pt", italian: "it", russian: "ru", japanese: "ja", korean: "ko", chinese: "zh",
};

/** "hin" → "hi", "eng" → "en", "Hindi" → "hi", "hi-IN" → "hi-IN"; garbage → null. */
export function normalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const named = NAMES[raw.toLowerCase()];
  if (named) return named;
  const match = /^([a-z]{2,3})(?:[-_]([a-z]{2}|\d{3}))?$/i.exec(raw);
  if (!match) return null;
  const primary = match[1]!.toLowerCase();
  const language = ISO_639_3_TO_1[primary] ?? primary;
  return match[2] ? `${language}-${match[2].toUpperCase()}` : language;
}
