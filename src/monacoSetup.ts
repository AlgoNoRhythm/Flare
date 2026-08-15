import * as monaco from 'monaco-editor';
import { onThemeChange } from './theme';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

/**
 * The editor theme, built from the app's own tokens.
 *
 * It used to be thirty-five hand-picked hexes here — a second palette, tuned
 * for the dark surface and unable to follow the app anywhere else. Almost all
 * of them were really "one step off the editor background" or "the brand
 * orange", so they are derived from the ramp instead and the editor now moves
 * with the theme by construction.
 *
 * What is *not* derived is what the ramp cannot say: the three bracket hues
 * and the diff washes, which carry meaning rather than depth. Those are tokens
 * of their own, in both palettes.
 *
 * vs-dark draws indent guides at #404040 on its own background, which on this
 * darker surface is close to invisible — and indentation is exactly what has
 * to be readable in a file an agent wrote. --n7 is the step that actually
 * resolves on screen: a 1px hairline needs a much bigger step off the
 * background than a filled shape does.
 */
function token(name: string, fallback = '#000000'): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export function defineEditorTheme(): void {
  const t = token;
  const guide = t('--n7');
  const guideActive = t('--n10');
  const border = t('--n5');
  const inserted = t('--diff-add-line');
  const removed = t('--diff-del-line');
  const insertedGutter = t('--diff-add-gutter');
  const removedGutter = t('--diff-del-gutter');

  monaco.editor.defineTheme('flare', {
    // vs-dark inherits sensible syntax colours for a dark ground and vs for a
    // light one; the surfaces below are ours either way
    base: document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': t('--n1'),
      'editor.lineHighlightBackground': t('--n2'),
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': t('--n1'),
      'editorLineNumber.foreground': t('--n8'),
      'editorLineNumber.activeForeground': t('--n11'),
      'editorIndentGuide.background1': guide,
      'editorIndentGuide.background2': guide,
      'editorIndentGuide.background3': guide,
      'editorIndentGuide.background4': guide,
      'editorIndentGuide.background5': guide,
      'editorIndentGuide.background6': guide,
      'editorIndentGuide.activeBackground1': guideActive,
      'editorIndentGuide.activeBackground2': guideActive,
      'editorIndentGuide.activeBackground3': guideActive,
      'editorIndentGuide.activeBackground4': guideActive,
      'editorIndentGuide.activeBackground5': guideActive,
      'editorIndentGuide.activeBackground6': guideActive,
      'editorWhitespace.foreground': t('--n6'),
      'editorBracketHighlight.foreground1': t('--bracket-1'),
      'editorBracketHighlight.foreground2': t('--bracket-2'),
      'editorBracketHighlight.foreground3': t('--bracket-3'),
      /*
       * Diff colours, stated rather than inherited.
       *
       * The defaults are near-black tints that vanish against this surface, so
       * a diff read as two panes of identical-looking code and the reader had
       * to find the change by eye. Added lines go green, removed red, with the
       * word-level highlight stronger than the line wash so "this line
       * changed" and "this is what changed in it" stay separable at a glance.
       */
      'diffEditor.insertedLineBackground': inserted,
      'diffEditor.removedLineBackground': removed,
      'diffEditor.insertedTextBackground': t('--diff-add-text'),
      'diffEditor.removedTextBackground': t('--diff-del-text'),
      'diffEditorGutter.insertedLineBackground': insertedGutter,
      'diffEditorGutter.removedLineBackground': removedGutter,
      'diffEditorOverview.insertedForeground': t('--diff-add-mark'),
      'diffEditorOverview.removedForeground': t('--diff-del-mark'),
      'diffEditor.border': border,
      'diffEditor.diagonalFill': t('--n4'),
      'editorStickyScroll.background': t('--n2'),
      'editorStickyScrollHover.background': t('--n3'),
      'editorStickyScroll.border': border,
      // the caret is the app speaking, not the language — brand orange
      'editorCursor.foreground': t('--accent'),
      'editor.selectionBackground': t('--accent-bg-strong'),
      'editor.inactiveSelectionBackground': t('--accent-bg'),
      'editor.selectionHighlightBackground': t('--accent-bg'),
      'minimap.background': t('--n0'),
    },
  });
  // redefining the theme it is already using is what repaints open editors
  monaco.editor.setTheme('flare');
}

defineEditorTheme();
onThemeChange(defineEditorTheme);

// The IDE indexes cross-file imports itself; Monaco shouldn't error on them.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});

export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sh: 'shell',
    ps1: 'powershell',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    sql: 'sql',
    toml: 'ini',
    ini: 'ini',
  };
  return map[ext] ?? 'plaintext';
}

export { monaco };
