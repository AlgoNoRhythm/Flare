import { useEffect, useRef } from 'react';
import { api } from '../api';
import { languageForPath, monaco } from '../monacoSetup';

interface Props {
  path: string;
  /** Bumped when the file changed on disk (external edit, e.g. by an agent). */
  externalVersion: number;
  /** Scroll to this 1-based line when set (symbol drill-down "open at line"). */
  revealLine?: number;
  onDirtyChange(path: string, dirty: boolean): void;
}

export function EditorPane({ path, externalVersion, revealLine, onDirtyChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const savedContentRef = useRef<string>('');
  const dirtyRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      theme: 'flare',
      automaticLayout: true,
      minimap: { enabled: true },
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
      fontSize: 14,
      // Most files here are 2-space indented, so a level is only a couple of
      // characters wide and no editor setting can widen it — the literal spaces
      // are in the file. Depth is carried by the guides and the sticky header
      // instead, with the line height opened up so the columns of guides read
      // as vertical lines rather than a dotted texture.
      lineHeight: 22,
      letterSpacing: 0.5,
      guides: {
        indentation: true,
        highlightActiveIndentation: true,
        bracketPairs: 'active',
      },
      bracketPairColorization: { enabled: true },
      // deep nesting is where you lose the thread of which block you are in
      stickyScroll: { enabled: true, maxLineCount: 4 },
      tabSize: 2,
      detectIndentation: true,
      padding: { top: 10, bottom: 12 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      renderLineHighlight: 'all',
      smoothScrolling: true,
      model: null,
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const model = editor.getModel();
      if (!model) return;
      const content = model.getValue();
      void api.writeFile(path, content).then((ok) => {
        if (ok) {
          savedContentRef.current = content;
          dirtyRef.current = false;
          onDirtyChange(path, false);
        }
      });
    });

    return () => {
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // load / reload content
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;
    void api.readFile(path).then((content) => {
      if (cancelled || content === null) return;
      const current = editor.getModel();
      if (current && dirtyRef.current && externalVersion > 0) {
        // don't clobber unsaved local edits with external changes
        return;
      }
      savedContentRef.current = content;
      if (current) {
        if (current.getValue() !== content) current.setValue(content);
      } else {
        const model = monaco.editor.createModel(
          content,
          languageForPath(path),
          monaco.Uri.file(`flare/${path}`),
        );
        editor.setModel(model);
        model.onDidChangeContent(() => {
          const dirty = model.getValue() !== savedContentRef.current;
          if (dirty !== dirtyRef.current) {
            dirtyRef.current = dirty;
            onDirtyChange(path, dirty);
          }
        });
      }
      dirtyRef.current = false;
      onDirtyChange(path, false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, externalVersion]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && revealLine && revealLine > 0) {
      editor.revealLineInCenter(revealLine);
      editor.setPosition({ lineNumber: revealLine, column: 1 });
      editor.focus();
    }
  }, [revealLine, path]);

  return <div className="editor-host" ref={hostRef} data-testid={`editor-${path}`} />;
}
