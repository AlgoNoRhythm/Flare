import * as monaco from 'monaco-editor';
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
 * The editor theme.
 *
 * vs-dark draws indent guides at #404040 on its own #1e1e1e background, which
 * on this darker surface is close to invisible — and indentation is exactly
 * what has to be readable in a file an agent wrote. The guides are lifted well
 * clear of the background, the active one further still, and the editor
 * surface is matched to the app so the panel does not read as a lighter box.
 */
monaco.editor.defineTheme('flare', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#121419',
    'editor.lineHighlightBackground': '#181b22',
    'editor.lineHighlightBorder': '#00000000',
    'editorGutter.background': '#121419',
    'editorLineNumber.foreground': '#474d57',
    'editorLineNumber.activeForeground': '#a9adb5',
    // A 1px hairline needs a much bigger step off the background than a filled
    // shape does. #2b313c measured as present-but-unreadable against #121419;
    // these are the values that actually resolve on screen.
    'editorIndentGuide.background1': '#3d4655',
    'editorIndentGuide.background2': '#3d4655',
    'editorIndentGuide.background3': '#3d4655',
    'editorIndentGuide.background4': '#3d4655',
    'editorIndentGuide.background5': '#3d4655',
    'editorIndentGuide.background6': '#3d4655',
    'editorIndentGuide.activeBackground1': '#8592a6',
    'editorIndentGuide.activeBackground2': '#8592a6',
    'editorIndentGuide.activeBackground3': '#8592a6',
    'editorIndentGuide.activeBackground4': '#8592a6',
    'editorIndentGuide.activeBackground5': '#8592a6',
    'editorIndentGuide.activeBackground6': '#8592a6',
    'editorWhitespace.foreground': '#2b313c',
    'editorBracketHighlight.foreground1': '#7dbcff',
    'editorBracketHighlight.foreground2': '#d9a441',
    'editorBracketHighlight.foreground3': '#b58bd8',
    /*
     * Diff colours, stated rather than inherited.
     *
     * vs-dark's defaults are near-black tints that vanish against this
     * surface, so a diff read as two panes of identical-looking code and the
     * reader had to find the change by eye. Added lines go green, removed red,
     * with the word-level highlight stronger than the line wash so "this line
     * changed" and "this is what changed in it" are separable at a glance.
     */
    'diffEditor.insertedLineBackground': '#12401f4d',
    'diffEditor.removedLineBackground': '#4a13134d',
    'diffEditor.insertedTextBackground': '#2ea04359',
    'diffEditor.removedTextBackground': '#e5484d4d',
    'diffEditorGutter.insertedLineBackground': '#12401f80',
    'diffEditorGutter.removedLineBackground': '#4a131380',
    'diffEditorOverview.insertedForeground': '#3fb950cc',
    'diffEditorOverview.removedForeground': '#e5484dcc',
    'diffEditor.border': '#272c36',
    'diffEditor.diagonalFill': '#20242c',
    'editorStickyScroll.background': '#171a21',
    'editorStickyScrollHover.background': '#1e222b',
    'editorStickyScroll.border': '#272c36',
    // the caret is the app speaking, not the language — brand orange
    'editorCursor.foreground': '#e08a52',
    'editor.selectionBackground': '#3d2718',
    'editor.inactiveSelectionBackground': '#2a1a11',
    'editor.selectionHighlightBackground': '#33211550',
    'minimap.background': '#101216',
  },
});

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
