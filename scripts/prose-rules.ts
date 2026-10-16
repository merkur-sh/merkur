/**
 * The prose rules: the phrasings that mark text as generated rather than written. `check:docs`
 * holds the first-party Markdown to them (C9 `prose`) and the `commit-msg` hook holds commit
 * messages to them (`scripts/check-commit-message.ts`), so a rule here is enforced in both.
 *
 * Each rule is a pattern over one line of prose (code spans and fenced code already removed by
 * the caller) and a repair instruction. The word lists are the ones that measured clean on this
 * tree's own prose: "unlock" was left out because here it is the verb of the key hierarchy.
 */

export interface ProseRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly message: string;
}

export interface ProseFinding {
  readonly line: number;
  readonly rule: string;
  readonly text: string;
  readonly message: string;
}

export const PROSE_RULES: readonly ProseRule[] = [
  {
    name: 'not-x-but-y',
    pattern:
      /\b(?:it'?s|this is|that'?s|is) not (?:just |only |merely )?[^.;:\n]{1,60}?[,;—–] ?(?:it'?s|but|it is)\b|\b(?:isn'?t|is not|aren'?t|are not) (?:just|only|merely)\b/giu,
    message: 'state what the thing is; the denied alternative is a reveal, not information',
  },
  {
    name: 'stock-word',
    pattern:
      /\b(?:seamless(?:ly)?|robust(?:ly|ness)?|leverag(?:e|es|ed|ing)|comprehensive(?:ly)?|delv(?:e|es|ed|ing)|utili[sz](?:e|es|ed|ing|ation))\b/giu,
    message: 'name the property or the act the word stands in for',
  },
  {
    name: 'filler',
    pattern:
      /\b(?:it'?s|it is) worth noting\b|\bworth noting that\b|\bit is important to note\b|\bgame[- ]changer\b|\bcutting[- ]edge\b|\bstate[- ]of[- ]the[- ]art\b|\bin today'?s\b|\bplays? an? (?:crucial|key|vital|pivotal) role\b|\ba testament to\b/giu,
    message: 'cut the frame and say the fact',
  },
  {
    name: 'bold-label',
    pattern: /^\s*(?:[-*]|\d+\.) \*\*[^*]+(?::\*\*|\*\*:)/gu,
    message: 'write the item as a sentence; a bold label before a colon is a heading in disguise',
  },
];

/** Every rule's matches over the given lines, in line order. */
export function findProseSlop(
  lines: Iterable<{ readonly line: number; readonly text: string }>,
): ProseFinding[] {
  const findings: ProseFinding[] = [];
  for (const { line, text } of lines) {
    for (const rule of PROSE_RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        findings.push({ line, rule: rule.name, text: match[0], message: rule.message });
      }
    }
  }
  return findings;
}
