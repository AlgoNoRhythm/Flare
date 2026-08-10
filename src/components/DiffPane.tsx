import { useEffect, useRef } from 'react';
import { api } from '../api';
import { languageForPath, monaco } from '../monacoSetup';

interface Props {
  path: string;
  /** 'head' diffs vs git HEAD; otherwise a shadow snapshot hash. */
  source: 'head' | { hash: string };
  externalVersion: number;
}

export function DiffPane({ path, source, externalVersion }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.createDiffEditor(host, {
      theme: 'flare',
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      // the ± marks in the gutter, so the change is legible without relying on
      // colour alone
      renderIndicators: true,
      renderOverviewRuler: true,
      // An agent that only re-indents a block is a real thing to catch, and the
      // default hides exactly that.
      ignoreTrimWhitespace: false,
      renderLineHighlight: 'none',
    });
    editorRef.current = editor;
    return () => {
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
  }, [path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;
    let sub: monaco.IDisposable | null = null;
    const originalPromise =
      source === 'head' ? api.gitShowHead(path) : api.shadowShow(source.hash, path);
    void Promise.all([originalPromise, api.readFile(path)]).then(([original, current]) => {
      if (cancelled) return;
      const lang = languageForPath(path);
      const old = editor.getModel();
      const originalModel = monaco.editor.createModel(original ?? '', lang);
      const modifiedModel = monaco.editor.createModel(current ?? '', lang);
      editor.setModel({ original: originalModel, modified: modifiedModel });
      old?.original.dispose();
      old?.modified.dispose();

      /*
       * Open on the change, not on line 1.
       *
       * A diff of a 300-line file whose one edit is at line 240 opens on three
       * screens of unchanged code, and the person who came to see what an agent
       * did has to go looking for it. The diff is computed asynchronously, so
       * this waits for the first result and then scrolls to it — once, because
       * after that the scroll position is the reader's.
       */
      sub = editor.onDidUpdateDiff(() => {
        sub?.dispose();
        sub = null;
        const first = editor.getLineChanges()?.[0];
        if (!first) return;
        const line = first.modifiedStartLineNumber || first.originalStartLineNumber || 1;
        editor.getModifiedEditor().revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
      });
    });
    return () => {
      cancelled = true;
      sub?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(source), externalVersion]);

  return <div className="editor-host" ref={hostRef} data-testid={`diff-${path}`} />;
}
