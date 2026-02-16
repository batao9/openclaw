type FenceSpan = {
  start: number;
  end: number;
};

type InlineCodeState = {
  open: boolean;
  ticks: number;
};

type CodeSpanIndex = {
  isInside: (index: number) => boolean;
};

export function buildCodeSpanIndex(text: string): CodeSpanIndex {
  const fenceSpans = parseFenceSpans(text);
  const inlineSpans = parseInlineCodeSpans(text, fenceSpans);

  return {
    isInside: (index: number) =>
      isInsideSpan(index, fenceSpans) || isInsideSpan(index, inlineSpans),
  };
}

function parseFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLen: number;
      }
    | undefined;

  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const marker = match[2] ?? "";
      const markerChar = marker[0] ?? "";
      const markerLen = marker.length;
      if (!open) {
        open = { start: offset, markerChar, markerLen };
      } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
        spans.push({ start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  if (open) {
    spans.push({ start: open.start, end: buffer.length });
  }
  return spans;
}

function parseInlineCodeSpans(text: string, fenceSpans: FenceSpan[]): FenceSpan[] {
  const spans: FenceSpan[] = [];
  const state: InlineCodeState = { open: false, ticks: 0 };
  let openStart = -1;

  let i = 0;
  while (i < text.length) {
    const fence = fenceSpans.find((span) => i >= span.start && i < span.end);
    if (fence) {
      i = fence.end;
      continue;
    }
    if (text[i] !== "`") {
      i += 1;
      continue;
    }

    const runStart = i;
    let runLength = 0;
    while (i < text.length && text[i] === "`") {
      runLength += 1;
      i += 1;
    }

    if (!state.open) {
      state.open = true;
      state.ticks = runLength;
      openStart = runStart;
      continue;
    }
    if (runLength === state.ticks) {
      spans.push({ start: openStart, end: i });
      state.open = false;
      state.ticks = 0;
      openStart = -1;
    }
  }

  if (state.open) {
    spans.push({ start: openStart, end: text.length });
  }
  return spans;
}

function isInsideSpan(index: number, spans: FenceSpan[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}
