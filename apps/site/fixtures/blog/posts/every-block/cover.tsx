/**
 * The picture the index shows for this post: figure 2's terminal just after
 * `git status`, with the updates that drew it. Build time only; nothing moves.
 */
import type { JSX } from '@solidjs/web';

import { type Line, PROMPT, seg } from '../../../../src/blog/kit/lines';
import { Segments } from '../../../../src/blog/kit/terminal';

const SCREEN: readonly { number: string; line: Line; flash?: 'sent' | 'moved'; caret?: true }[] = [
  { number: '05', line: [...PROMPT, seg('ls')] },
  {
    number: '06',
    line: [seg('apps  crates  docs  notes', 'blue'), seg('  Cargo.toml')],
    flash: 'moved',
  },
  { number: '07', line: [...PROMPT, seg('git status')], flash: 'sent' },
  { number: '08', line: [seg('On branch main')], flash: 'sent' },
  { number: '09', line: [seg('  modified: crates/proto/src/diff.rs', 'red')], flash: 'sent' },
  { number: '10', line: PROMPT, flash: 'sent', caret: true },
];

const WIRE = ['v4191 shift ↑2 + rows 7–10', 'v4190 row 7', 'v4189 row 7', 'v4188 row 7'];

export default function Cover(): JSX.Element {
  return (
    <div class="ft ft-wired" data-cover>
      <div class="ft-screen">
        <div class="ft-head ft-head-mono">
          <span class="ft-dot" data-link="up" />
          Mac.bbrouter
        </div>
        <div class="ft-rows">
          {SCREEN.map((row) => (
            <div class="ft-row ft-numbered" data-flash={row.flash}>
              <span class="ft-bar" />
              <span class="ft-number">{row.number}</span>
              <span class="ft-text">
                <Segments line={row.line} />
                {row.caret === true && <span class="ft-caret" />}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div class="wire">
        <div class="wire-log">
          {WIRE.map((update, index) => (
            <span class="wire-line" data-latest={index === 0 ? '' : undefined}>
              {update}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
