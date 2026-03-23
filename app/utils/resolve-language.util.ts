/**
 * Language resolution utility for flashcard i18n.
 *
 * Overlays translated fields onto a flashcard document and strips the
 * `translations` map so clients receive a flat object in their preferred language.
 * Missing translated fields fall back to the card's default language (English).
 */

// Top-level translatable scalar fields (all card types)
const TOP_LEVEL_FIELDS = ['front', 'back', 'hint'] as const;

/**
 * Deep-clone a plain object (Mongoose lean docs / POJOs).
 * Handles Map instances returned by Mongoose for `Map` schema fields.
 */
function clone(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Map) {
    const m = new Map();
    obj.forEach((v: any, k: any) => m.set(k, clone(v)));
    return m;
  }
  if (Array.isArray(obj)) return obj.map(clone);
  if (typeof obj === 'object' && obj.constructor === Object) {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = clone(obj[k]);
    return out;
  }
  return obj;
}

/**
 * Apply nested translated fields for structured card sub-objects.
 *
 * Handles:
 *  - options[]              (multipleChoice)
 *  - matchPairs[].leftItem.content, .rightItem.content, .feedback
 *  - fillInBlanksData.text, .blanks[].answer, .blanks[].options
 *  - codeData.explanation
 *  - chessData.openingName, .commentary[]
 *  - openingLesson.openingName, .description, .title
 *  - famousGame.title, .description
 */
function applyNestedTranslations(card: any, t: any): void {
  // options[] (multipleChoice)
  if (t.options && Array.isArray(t.options) && Array.isArray(card.options)) {
    for (let i = 0; i < t.options.length && i < card.options.length; i++) {
      if (t.options[i] != null) card.options[i] = t.options[i];
    }
  }

  // matchPairs[]
  if (t.matchPairs && Array.isArray(t.matchPairs) && Array.isArray(card.matchPairs)) {
    for (let i = 0; i < t.matchPairs.length && i < card.matchPairs.length; i++) {
      const tp = t.matchPairs[i];
      if (!tp) continue;
      const cp = card.matchPairs[i];
      if (tp.leftItem?.content != null && cp.leftItem) cp.leftItem.content = tp.leftItem.content;
      if (tp.rightItem?.content != null && cp.rightItem) cp.rightItem.content = tp.rightItem.content;
      if (tp.feedback != null) cp.feedback = tp.feedback;
    }
  }

  // fillInBlanksData
  if (t.fillInBlanksData && card.fillInBlanksData) {
    if (t.fillInBlanksData.text != null) card.fillInBlanksData.text = t.fillInBlanksData.text;
    if (t.fillInBlanksData.blanks && Array.isArray(t.fillInBlanksData.blanks) && Array.isArray(card.fillInBlanksData.blanks)) {
      for (let i = 0; i < t.fillInBlanksData.blanks.length && i < card.fillInBlanksData.blanks.length; i++) {
        const tb = t.fillInBlanksData.blanks[i];
        if (!tb) continue;
        const cb = card.fillInBlanksData.blanks[i];
        if (tb.answer != null) cb.answer = tb.answer;
        if (tb.options && Array.isArray(tb.options)) cb.options = tb.options;
      }
    }
  }

  // codeData.explanation
  if (t.codeData?.explanation != null && card.codeData) {
    card.codeData.explanation = t.codeData.explanation;
  }

  // chessData.openingName, .commentary[]
  if (t.chessData && card.chessData) {
    if (t.chessData.openingName != null) card.chessData.openingName = t.chessData.openingName;
    if (t.chessData.commentary && Array.isArray(t.chessData.commentary) && Array.isArray(card.chessData.commentary)) {
      for (let i = 0; i < t.chessData.commentary.length && i < card.chessData.commentary.length; i++) {
        if (t.chessData.commentary[i] != null) card.chessData.commentary[i] = t.chessData.commentary[i];
      }
    }
  }

  // openingLesson
  if (t.openingLesson && card.openingLesson) {
    for (const f of ['openingName', 'description', 'title'] as const) {
      if (t.openingLesson[f] != null) (card.openingLesson as any)[f] = t.openingLesson[f];
    }
  }

  // famousGame
  if (t.famousGame && card.famousGame) {
    for (const f of ['title', 'description'] as const) {
      if (t.famousGame[f] != null) (card.famousGame as any)[f] = t.famousGame[f];
    }
  }
}

/**
 * Get the translations map as a plain object, handling both Mongoose Map and POJO.
 */
function getTranslationsObj(card: any): Record<string, any> | null {
  if (!card.translations) return null;
  if (card.translations instanceof Map) {
    const obj: Record<string, any> = {};
    card.translations.forEach((v: any, k: string) => { obj[k] = v; });
    return obj;
  }
  if (typeof card.translations === 'object') return card.translations;
  return null;
}

/**
 * Resolve a single flashcard to the requested language.
 *
 * - If `lang` is 'en' or matches `card.defaultLanguage`, returns as-is (minus `translations`).
 * - If no translations exist for `lang`, falls back to English.
 * - Overlays only the fields present in the translation; missing ones keep their English value.
 * - Always strips `translations` from the output.
 *
 * @param card  A lean Mongoose document (POJO)
 * @param lang  ISO 639-1 language code (e.g. 'es', 'fr')
 * @returns     A new object with translated content and no `translations` key
 */
export function resolveLanguage(card: any, lang: string): any {
  if (!card) return card;

  const defaultLang = card.defaultLanguage || 'en';

  // Fast path: requesting default language — just strip translations
  if (!lang || lang === defaultLang) {
    const out = clone(card);
    delete out.translations;
    return out;
  }

  const trMap = getTranslationsObj(card);
  const t = trMap?.[lang];

  // No translation for this language — fall back to default
  if (!t) {
    const out = clone(card);
    delete out.translations;
    return out;
  }

  // Clone and overlay
  const out = clone(card);

  // Overlay top-level scalars
  for (const f of TOP_LEVEL_FIELDS) {
    if (t[f] != null) out[f] = t[f];
  }

  // Overlay nested structures
  applyNestedTranslations(out, t);

  // Strip translations map from output
  delete out.translations;

  return out;
}

/**
 * Resolve an array of flashcards to the requested language.
 */
export function resolveLanguageMany(cards: any[], lang: string): any[] {
  if (!cards || !Array.isArray(cards)) return cards;
  if (!lang || lang === 'en') {
    // Fast path: strip translations from each card
    return cards.map(c => {
      if (!c) return c;
      const out = clone(c);
      delete out.translations;
      return out;
    });
  }
  return cards.map(c => resolveLanguage(c, lang));
}
