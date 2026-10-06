import { type Component, createEffect, type Element, For } from 'solid-js';

import ToggleSwitch from '../components/ToggleSwitch';
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  TERMINAL_LINE_HEIGHT,
  type TerminalAppearance,
} from '../terminal/appearance';
import {
  TERMINAL_FONTS,
  type TerminalFontFamily,
  type TerminalFontFamilyId,
} from '../terminal/fonts';
import type { TerminalNotificationState } from '../terminal/notifications';
import {
  rgbCss,
  TERMINAL_THEMES,
  type TerminalTheme,
  type TerminalThemeId,
} from '../terminal/themes';

const previewLoadedFonts = new Set<string>();

interface Props {
  readonly terminalAppearance: TerminalAppearance;
  readonly terminalNotificationState: TerminalNotificationState;
  onTerminalFontFamilyChange(fontFamilyId: TerminalFontFamilyId): void;
  onTerminalFontSizeChange(fontSize: number): void;
  onTerminalNotificationsDisable(): Promise<void>;
  onTerminalNotificationsEnable(): Promise<void>;
  onTerminalThemeChange(themeId: TerminalThemeId): void;
}

/**
 * What the grid looks like: theme, face, size, and the one notification the
 * terminal can raise.
 *
 * The preview is pinned to the top of the tab and every control below it writes
 * straight through, so a choice is seen in the thing it changes rather than
 * described beside it.
 */
const TerminalSettings: Component<Props> = (props) => {
  createEffect(
    () => props.terminalAppearance.fontFamilyId,
    (fontFamilyId) => {
      loadPreviewFont(TERMINAL_FONTS[fontFamilyId]);
    },
  );

  return (
    <>
      <TerminalPreview appearance={props.terminalAppearance} />

      <section class="flex flex-col gap-[10px]">
        <h2 class="eyebrow">Theme</h2>
        <div class="grid grid-cols-3 gap-[10px]">
          <For each={Object.entries(TERMINAL_THEMES)}>
            {([id, theme]) => (
              <ChoiceTile
                selected={props.terminalAppearance.themeId === id}
                onSelect={() => props.onTerminalThemeChange(id as TerminalThemeId)}
              >
                <div
                  class="relative h-14 overflow-hidden rounded-sm px-[9px] py-[6px] font-mono text-[11px] leading-[1.45]"
                  style={{
                    color: rgbCss(theme.foreground),
                    'background-color': rgbCss(theme.background),
                  }}
                >
                  <div>
                    <span style={{ color: rgbCss(theme.palette[5] ?? theme.foreground) }}>$ </span>
                    <span style={{ color: rgbCss(theme.palette[2] ?? theme.foreground) }}>ls</span>
                  </div>
                  <div style={{ color: rgbCss(theme.palette[3] ?? theme.foreground) }}>src/</div>
                  <span
                    class="absolute bottom-2 right-2 h-[14px] w-[3px] rounded-[1px]"
                    style={{ 'background-color': rgbCss(theme.cursor) }}
                  />
                </div>
                <div
                  class={[
                    'truncate pt-[9px] text-center text-[13px] font-medium',
                    {
                      'text-ink': props.terminalAppearance.themeId === id,
                      'text-meta': props.terminalAppearance.themeId !== id,
                    },
                  ]}
                >
                  {themeLabel(theme.name)}
                </div>
              </ChoiceTile>
            )}
          </For>
        </div>
      </section>

      <section class="flex flex-col gap-[10px]">
        <h2 class="eyebrow">Font family</h2>
        <div class="grid grid-cols-2 gap-[10px]">
          <For each={Object.entries(TERMINAL_FONTS)}>
            {([id, fontFamily]) => (
              <ChoiceTile
                selected={props.terminalAppearance.fontFamilyId === id}
                onSelect={() => props.onTerminalFontFamilyChange(id as TerminalFontFamilyId)}
                padded
              >
                <span
                  class={[
                    'block truncate text-[14px] font-medium leading-5',
                    {
                      'text-ink': props.terminalAppearance.fontFamilyId === id,
                      'text-meta': props.terminalAppearance.fontFamilyId !== id,
                    },
                  ]}
                >
                  {fontFamilyLabel(fontFamily.name)}
                </span>
                <span class="block truncate pt-[2px] text-[11.5px] text-meta">Nerd Font</span>
              </ChoiceTile>
            )}
          </For>
        </div>
      </section>

      <section class="flex flex-col gap-[10px]">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="eyebrow">Font size</h2>
          <span class="font-mono text-[13px] tabular-nums text-ink">
            {props.terminalAppearance.fontSize}px
          </span>
        </div>
        <div class="pref-group px-4 pb-[10px] pt-[14px]">
          <FontSizeSlider
            fontSize={props.terminalAppearance.fontSize}
            onChange={props.onTerminalFontSizeChange}
          />
          <div class="flex justify-between pt-[6px] font-mono text-[11px] tabular-nums text-meta">
            <span>{MIN_TERMINAL_FONT_SIZE}px</span>
            <span>{MAX_TERMINAL_FONT_SIZE}px</span>
          </div>
        </div>
      </section>

      <section class="flex flex-col gap-[10px]">
        <h2 class="eyebrow">Notifications</h2>
        <div class="pref-group">
          <div class="pref-row">
            <span class="min-w-0 flex-1">
              <span class="pref-name">Terminal bell</span>
              <span class="pref-sub">Notifies when this tab is in the background</span>
            </span>
            <ToggleSwitch
              label="Terminal bell notifications"
              checked={props.terminalNotificationState === 'enabled'}
              disabled={notificationSwitchDisabled(props.terminalNotificationState)}
              onChange={() =>
                props.terminalNotificationState === 'enabled'
                  ? void props.onTerminalNotificationsDisable()
                  : void props.onTerminalNotificationsEnable()
              }
            />
          </div>
        </div>
      </section>
    </>
  );
};

export default TerminalSettings;

/**
 * One choice in a row of them. The chosen tile takes the accent edge and fill
 * and nothing else moves — a tile that also grew or lifted would make the
 * choice look like a press that had not finished. The accent, deliberately,
 * where the tab bar and the cursor row use ink: a theme or a face is a choice
 * that is made once and lived with, and the tint is what makes the chosen one
 * readable at a glance in a row of three previews that are all dark.
 */
const ChoiceTile: Component<{
  readonly selected: boolean;
  readonly padded?: boolean;
  readonly children: Element;
  onSelect(): void;
}> = (props) => (
  <button
    type="button"
    aria-pressed={props.selected ? 'true' : 'false'}
    onClick={props.onSelect}
    class={[
      'focusable min-w-0 cursor-pointer rounded-md border border-solid text-left tap-transparent transition-[background-color,border-color,transform] duration-tint active:duration-0 active:scale-[0.985] motion-reduce:transition-none',
      {
        'border-accentline bg-accentsoft': props.selected,
        'border-line2 bg-transparent': !props.selected,
        'px-[14px] py-3': props.padded === true,
        'p-2': props.padded !== true,
      },
    ]}
  >
    {props.children}
  </button>
);

/**
 * Continuous font size, drawn rather than themed.
 *
 * The track and its filled portion are elements so both engines paint the same
 * slider out of the palette; the native input stays on top, transparent apart
 * from its thumb, so pointer capture, touch, and the arrow keys remain the
 * browser's job. The thumb utilities are spelled out per engine rather than
 * shared through a constant because UnoCSS extracts class names from the source
 * text — an interpolated string generates no CSS at all.
 */
const SLIDER_THUMB_PX = 14;

const FontSizeSlider: Component<{ fontSize: number; onChange: (fontSize: number) => void }> = (
  props,
) => {
  // Where the thumb's centre sits: it travels between half a thumb in from
  // each end, so the filled track has to stop there too rather than at the
  // element edge.
  const fillWidth = (): string => {
    const fraction =
      (props.fontSize - MIN_TERMINAL_FONT_SIZE) / (MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE);
    return `calc(${SLIDER_THUMB_PX / 2}px + ${fraction} * (100% - ${SLIDER_THUMB_PX}px))`;
  };

  return (
    <div class="relative flex h-6 items-center">
      <div class="pointer-events-none absolute inset-x-0 h-[4px] rounded-full bg-lifted" />
      <div
        class="pointer-events-none absolute left-0 h-[4px] rounded-full bg-accentlt"
        style={{ width: fillWidth() }}
      />
      <input
        type="range"
        min={MIN_TERMINAL_FONT_SIZE}
        max={MAX_TERMINAL_FONT_SIZE}
        step={TERMINAL_FONT_SIZE_STEP}
        value={props.fontSize}
        aria-label="Terminal font size"
        aria-valuetext={`${props.fontSize} pixels`}
        onInput={(event) => props.onChange(event.currentTarget.valueAsNumber)}
        class="focusable tap-transparent relative m-0 h-6 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-runnable-track]:(h-[4px] bg-transparent) [&::-webkit-slider-thumb]:(mt-[-5px] h-[14px] w-[14px] cursor-pointer appearance-none rounded-full border-none bg-white shadow-[0_1px_2px_rgba(0,0,0,0.45)]) [&::-moz-range-track]:(h-[4px] bg-transparent) [&::-moz-range-progress]:bg-transparent [&::-moz-range-thumb]:(h-[14px] w-[14px] cursor-pointer appearance-none rounded-full border-none bg-white shadow-[0_1px_2px_rgba(0,0,0,0.45)])"
      />
    </div>
  );
};

/**
 * The grid as it will look, pinned to the top of the tab so it stays in view
 * while the controls that change it scroll under it.
 */
const TerminalPreview: Component<{ appearance: TerminalAppearance }> = (props) => {
  const theme = () => TERMINAL_THEMES[props.appearance.themeId];
  const font = () => TERMINAL_FONTS[props.appearance.fontFamilyId];

  return (
    <section class="card sticky top-0 z-10 p-[14px]">
      <div>
        <h2 class="eyebrow">Preview</h2>
        <p class="pt-[3px] text-[11px] text-meta">
          {themeLabel(theme().name)} · {fontFamilyLabel(font().name)} · {props.appearance.fontSize}
          px
        </p>
      </div>

      <div
        class="relative mt-[10px] overflow-hidden rounded-sm px-3 py-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
        style={{
          color: rgbCss(theme().foreground),
          'background-color': rgbCss(theme().background),
          'font-family': `'${font().name}', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`,
          'font-size': `${props.appearance.fontSize}px`,
          'line-height': TERMINAL_LINE_HEIGHT,
        }}
      >
        <PreviewLine theme={theme()} command="merkur status" />
        <div>
          <span style={{ color: rgbCss(theme().palette[2] ?? theme().foreground) }}>online</span>
          <span> tunnel ready </span>
          <span style={{ color: rgbCss(theme().palette[4] ?? theme().foreground) }}>42ms</span>
        </div>
        <div>
          <span style={{ color: rgbCss(theme().palette[3] ?? theme().foreground) }}>~/project</span>
          <span> </span>
          <span style={{ color: rgbCss(theme().palette[5] ?? theme().foreground) }}>main</span>
        </div>
        <PreviewLine theme={theme()} command="bun run dev" active />
      </div>
    </section>
  );
};

const PreviewLine: Component<{ theme: TerminalTheme; command: string; active?: boolean }> = (
  props,
) => (
  <div>
    <span style={{ color: rgbCss(props.theme.palette[5] ?? props.theme.foreground) }}>$ </span>
    <span style={{ color: rgbCss(props.theme.palette[2] ?? props.theme.foreground) }}>
      {props.command}
    </span>
    <ShowCursor when={props.active === true} theme={props.theme} />
  </div>
);

const ShowCursor: Component<{ when: boolean; theme: TerminalTheme }> = (props) => (
  <span
    class="ml-1 inline-block h-[1em] w-[0.42em] translate-y-[0.15em] rounded-[1px]"
    style={{
      opacity: props.when ? 1 : 0,
      'background-color': rgbCss(props.theme.cursor),
    }}
  />
);

function themeLabel(name: string): string {
  return name.replace(/^Catppuccin\s+/, '');
}

function fontFamilyLabel(name: string): string {
  return name.replace(/\s+Nerd Font$/, '');
}

function notificationSwitchDisabled(state: TerminalNotificationState): boolean {
  return state === 'unsupported' || state === 'not-installed' || state === 'denied';
}

function loadPreviewFont(font: TerminalFontFamily): void {
  if (!('fonts' in document) || previewLoadedFonts.has(font.name)) {
    return;
  }

  previewLoadedFonts.add(font.name);
  // The preview renders ASCII sample lines and the family name, all of which
  // the boot face covers. Using the full regular face here meant a ~1MB
  // download the moment settings opened, competing with the promotion fetch.
  const face = new FontFace(font.name, `url(${font.boot})`);
  document.fonts.add(face);
  void face.load().catch(() => undefined);
}
