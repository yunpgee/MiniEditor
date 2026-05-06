import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, lineNumbers as cmLineNumbers, Decoration, ViewPlugin } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap, undo, redo } from '@codemirror/commands';
import { foldGutter, foldService } from '@codemirror/language';

const wrapCompartment = new Compartment();
const lineNumbersCompartment = new Compartment();
const setReferenceDiagnosticsEffect = StateEffect.define();

const unresolvedReferenceDecoration = Decoration.mark({
  class: 'cm-unresolved-ref',
  attributes: {
    title: '未解決参照'
  }
});

const referenceDiagnosticsField = StateField.define({
  create() {
    return {
      missingLabels: []
    };
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setReferenceDiagnosticsEffect)) {
        return {
          missingLabels: Array.isArray(effect.value?.missingLabels)
            ? effect.value.missingLabels
            : []
        };
      }
    }

    return value;
  }
});

function findNextHeadingLine(state, startLineNumber, currentLevel) {
  for (let lineNumber = startLineNumber; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const match = line.text.match(/^(#{1,6})\s+/);
    if (!match) {
      continue;
    }

    if (match[1].length <= currentLevel) {
      return line;
    }
  }

  return null;
}

function buildHeadingFoldRange(state, lineStart) {
  const line = state.doc.lineAt(lineStart);
  const match = line.text.match(/^(#{1,6})\s+/);
  if (!match) {
    return null;
  }

  const currentLevel = match[1].length;
  const nextHeading = findNextHeadingLine(state, line.number + 1, currentLevel);
  const to = nextHeading ? nextHeading.from - 1 : state.doc.length;

  if (to <= line.to) {
    return null;
  }

  return {
    from: line.to,
    to
  };
}

function buildUnresolvedReferenceDecorations(state) {
  const diagnostics = state.field(referenceDiagnosticsField, false);
  const missingLabels = new Set(diagnostics?.missingLabels || []);

  if (missingLabels.size === 0) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder();
  const referencePattern = /@((?:fig|eq):[A-Za-z0-9_.:-]+)/g;
  let inFence = false;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const trimmed = line.text.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    for (const match of line.text.matchAll(referencePattern)) {
      const label = match[1];
      if (!missingLabels.has(label)) {
        continue;
      }

      const from = line.from + (match.index || 0);
      const to = from + match[0].length;
      builder.add(from, to, unresolvedReferenceDecoration);
    }
  }

  return builder.finish();
}

const unresolvedReferencePlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildUnresolvedReferenceDecorations(view.state);
  }

  update(update) {
    if (update.docChanged || update.startState.field(referenceDiagnosticsField) !== update.state.field(referenceDiagnosticsField)) {
      this.decorations = buildUnresolvedReferenceDecorations(update.state);
    }
  }
}, {
  decorations: (value) => value.decorations
});

const headingFoldService = foldService.of((state, lineStart) => buildHeadingFoldRange(state, lineStart));

function createFoldMarkerElement(open) {
  const marker = document.createElement('span');
  marker.className = `cm-foldMarker ${open ? 'is-open' : 'is-closed'}`;
  marker.setAttribute('aria-hidden', 'true');
  marker.title = open ? '折りたたむ' : '展開する';
  marker.textContent = open ? '▾' : '▸';
  return marker;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--panel)',
    color: 'var(--text)'
  },
  '.cm-scroller': {
    overflow: 'auto'
  },
  '.cm-content': {
    padding: '22px',
    fontFamily: 'var(--editor-font)',
    fontSize: 'var(--font-size)',
    lineHeight: '1.6',
    caretColor: 'var(--accent-strong)'
  },
  '.cm-focused': {
    outline: 'none'
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(15, 123, 126, 0.24)'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent-strong)'
  },
  '.cm-line': {
    padding: '0'
  },
  '.cm-unresolved-ref': {
    textDecoration: 'underline wavy var(--danger)',
    textUnderlineOffset: '0.12em'
  },
  '.cm-foldGutter .cm-gutterElement': {
    cursor: 'pointer'
  }
});

function clampPosition(state, position) {
  return Math.max(0, Math.min(Number(position) || 0, state.doc.length));
}

function selectionFromRange(state, from, to) {
  const start = clampPosition(state, Math.min(from, to));
  const end = clampPosition(state, Math.max(from, to));
  return start === end ? EditorSelection.cursor(start) : EditorSelection.range(start, end);
}

export function createEditorFacade(host, initialValue = '', { lineNumbersVisible = true } = {}) {
  const listeners = new Map();
  let suppressEvents = false;
  let wrapEnabled = true;
  let lineNumbersEnabled = Boolean(lineNumbersVisible);
  let referenceDiagnosticsSignature = '';

  const emit = (type, event) => {
    const handlers = listeners.get(type);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        console.error(`Editor listener failed for ${type}:`, error);
      }
    }
  };

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initialValue,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editorTheme,
        EditorView.contentAttributes.of({ spellcheck: 'false' }),
        headingFoldService,
        foldGutter({
          markerDOM: createFoldMarkerElement
        }),
        referenceDiagnosticsField,
        unresolvedReferencePlugin,
        lineNumbersCompartment.of(lineNumbersEnabled ? cmLineNumbers() : []),
        wrapCompartment.of(EditorView.lineWrapping),
        EditorView.updateListener.of((update) => {
          if (suppressEvents) {
            return;
          }

          if (update.docChanged) {
            emit('input', new Event('input'));
          }

          if (update.selectionSet) {
            emit('selectionchange', new Event('selectionchange'));
            emit('select', new Event('select'));
          }

        })
      ]
    })
  });

  const forward = (type) => {
    view.dom.addEventListener(type, (event) => emit(type, event));
  };

  forward('click');
  forward('keyup');
  forward('contextmenu');
  view.scrollDOM.addEventListener('scroll', (event) => emit('scroll', event));
  queueMicrotask(() => {
    if (host.isConnected) {
      view.focus();
    }
  });

  const api = {
    get value() {
      return view.state.doc.toString();
    },
    set value(nextValue) {
      const text = String(nextValue ?? '');
      suppressEvents = true;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: text
        },
        selection: EditorSelection.cursor(0)
      });
      suppressEvents = false;
    },
    get selectionStart() {
      return view.state.selection.main.from;
    },
    get selectionEnd() {
      return view.state.selection.main.to;
    },
    setSelectionRange(start, end) {
      const selection = selectionFromRange(view.state, start, end);
      suppressEvents = true;
      view.dispatch({ selection, scrollIntoView: true });
      suppressEvents = false;
      view.focus();
    },
    scrollLineIntoView(line, align = 'start') {
      const targetLine = Math.max(1, Math.min(Number(line) || 1, view.state.doc.lines));
      const lineInfo = view.state.doc.line(targetLine);
      suppressEvents = true;
      view.dispatch({
        selection: EditorSelection.cursor(lineInfo.from),
        effects: EditorView.scrollIntoView(lineInfo.from, {
          y: align
        })
      });
      suppressEvents = false;
      view.focus();
    },
    setRangeText(replacement, start, end, selectMode = 'end') {
      const from = clampPosition(view.state, start);
      const to = clampPosition(view.state, end);
      const text = String(replacement ?? '');
      let selection = EditorSelection.cursor(from + text.length);

      if (selectMode === 'select') {
        selection = EditorSelection.range(from, from + text.length);
      } else if (selectMode === 'start') {
        selection = EditorSelection.cursor(from);
      }

      suppressEvents = true;
      view.dispatch({
        changes: { from: Math.min(from, to), to: Math.max(from, to), insert: text },
        selection
      });
      suppressEvents = false;
    },
    focus() {
      view.focus();
    },
    get scrollTop() {
      return view.scrollDOM.scrollTop;
    },
    set scrollTop(value) {
      view.scrollDOM.scrollTop = Math.max(0, Number(value) || 0);
    },
    get clientHeight() {
      return view.scrollDOM.clientHeight;
    },
    get scrollHeight() {
      return view.scrollDOM.scrollHeight;
    },
    get wrap() {
      return wrapEnabled ? 'soft' : 'off';
    },
    set wrap(mode) {
      const enabled = mode !== 'off';
      if (enabled === wrapEnabled) {
        return;
      }

      wrapEnabled = enabled;
      view.dispatch({
        effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : [])
      });
    },
    setLineNumbersVisible(visible) {
      const enabled = Boolean(visible);
      if (enabled === lineNumbersEnabled) {
        return;
      }

      lineNumbersEnabled = enabled;
      view.dispatch({
        effects: lineNumbersCompartment.reconfigure(enabled ? cmLineNumbers() : [])
      });
    },
    setReferenceDiagnostics(diagnostics) {
      const missingLabels = new Set();

      for (const issue of diagnostics?.issues || []) {
        if (issue?.type === 'missing' && issue.label) {
          missingLabels.add(issue.label);
        }
      }

      const nextSignature = [...missingLabels].sort().join('\u0000');
      if (nextSignature === referenceDiagnosticsSignature) {
        return;
      }

      referenceDiagnosticsSignature = nextSignature;

      view.dispatch({
        effects: setReferenceDiagnosticsEffect.of({
          missingLabels: [...missingLabels]
        })
      });
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      const handlers = listeners.get(type);
      if (!handlers) {
        return;
      }

      handlers.delete(handler);
      if (handlers.size === 0) {
        listeners.delete(type);
      }
    },
    undo() {
      return undo(view);
    },
    redo() {
      return redo(view);
    },
    destroy() {
      view.destroy();
      listeners.clear();
    },
    get view() {
      return view;
    }
  };

  return api;
}
