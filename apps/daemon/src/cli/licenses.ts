import notices from '../../NOTICES.txt' with { type: 'text' };

/**
 * The AGPL text, the attribution for every dependency compiled into the shipped
 * executables, and the pointer to the corresponding source, compiled into the
 * binary by `bun build --compile`.
 *
 * The release archive holds three executables and nothing else, because the
 * updater's tar reader accepts exactly those entries; a notice file beside them
 * would have to weaken that check. Embedding the text instead means it travels
 * with the binary wherever the binary goes, which is what the MIT, BSD and
 * Apache-2.0 notices in it require. `scripts/generate-third-party-notices.ts`
 * regenerates the source file, and the release build runs it before compiling.
 */
export function runLicensesCommand(): string {
  return notices.endsWith('\n') ? notices : `${notices}\n`;
}
