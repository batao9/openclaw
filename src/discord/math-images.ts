import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import sharp from "sharp";
import type { DiscordMathImageConfig } from "../config/types.discord.js";
import { logVerbose } from "../globals.js";
import { buildCodeSpanIndex } from "../markdown/code-spans.js";

export type ResolvedDiscordMathImageConfig = {
  enabled: boolean;
  delimiters: Array<"double-dollar" | "bracket">;
  excludeCode: boolean;
  formulaTextFormat: "plain";
  maxExpressionsPerReply: number;
  maxCharsPerExpression: number;
  maxImageWidthPx: number;
};

export type DiscordMathSegment =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "math-image";
      formulaText: string;
      expression: string;
      imageBuffer: Buffer;
      fileName: string;
    };

export type DiscordMathSegmentResult = {
  segments: DiscordMathSegment[];
  hasMathImages: boolean;
  config: ResolvedDiscordMathImageConfig;
};

type DelimiterSpec = {
  kind: "double-dollar" | "bracket";
  open: string;
  close: string;
};

type FormulaToken = {
  kind: "formula";
  raw: string;
  expression: string;
};

type TextToken = {
  kind: "text";
  text: string;
};

type DiscordMathToken = FormulaToken | TextToken;

type MathjaxRuntime = {
  adaptor: ReturnType<typeof liteAdaptor>;
  document: ReturnType<typeof mathjax.document>;
};

type BuildDiscordMathSegmentsDeps = {
  renderFormulaPng?: (expression: string, maxImageWidthPx: number) => Promise<Buffer>;
};

const DEFAULT_DELIMITERS: Array<"double-dollar" | "bracket"> = ["double-dollar", "bracket"];
const DEFAULT_MAX_EXPRESSIONS = 8;
const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_MAX_IMAGE_WIDTH_PX = 2048;
const MATH_IMAGE_NAME_PREFIX = "equation";

const DELIMITER_SPECS: DelimiterSpec[] = [
  { kind: "double-dollar", open: "$$", close: "$$" },
  { kind: "bracket", open: "\\[", close: "\\]" },
];

let mathjaxRuntime: MathjaxRuntime | undefined;

export function resolveDiscordMathImageConfig(
  config?: DiscordMathImageConfig,
): ResolvedDiscordMathImageConfig {
  const delimiters =
    config?.delimiters?.filter(
      (value): value is "double-dollar" | "bracket" =>
        value === "double-dollar" || value === "bracket",
    ) ?? [];
  const normalizedDelimiters = delimiters.length > 0 ? delimiters : DEFAULT_DELIMITERS;
  return {
    enabled: config?.enabled ?? true,
    delimiters: normalizedDelimiters,
    excludeCode: config?.excludeCode ?? true,
    formulaTextFormat: "plain",
    maxExpressionsPerReply: normalizePositiveInt(
      config?.maxExpressionsPerReply,
      DEFAULT_MAX_EXPRESSIONS,
    ),
    maxCharsPerExpression: normalizePositiveInt(config?.maxCharsPerExpression, DEFAULT_MAX_CHARS),
    maxImageWidthPx: normalizePositiveInt(config?.maxImageWidthPx, DEFAULT_MAX_IMAGE_WIDTH_PX),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function getMathjaxRuntime(): MathjaxRuntime {
  if (mathjaxRuntime) {
    return mathjaxRuntime;
  }
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    packages: AllPackages,
  });
  const svg = new SVG({
    fontCache: "none",
  });
  const document = mathjax.document("", {
    InputJax: tex,
    OutputJax: svg,
  });
  mathjaxRuntime = { adaptor, document };
  return mathjaxRuntime;
}

async function renderFormulaPngDefault(
  expression: string,
  maxImageWidthPx: number,
): Promise<Buffer> {
  const runtime = getMathjaxRuntime();
  const node = runtime.document.convert(expression, {
    display: true,
  });
  const markup = runtime.adaptor.outerHTML(node);
  const svg = applySvgTextColor(extractSvgMarkup(markup), "#FFFFFF");
  let image = sharp(Buffer.from(svg), { density: 300 });
  const metadata = await image.metadata();
  if (typeof metadata.width === "number" && metadata.width > maxImageWidthPx) {
    image = image.resize({ width: maxImageWidthPx, withoutEnlargement: true });
  }
  return await image.png().toBuffer();
}

function extractSvgMarkup(markup: string): string {
  const start = markup.indexOf("<svg");
  const end = markup.lastIndexOf("</svg>");
  if (start < 0 || end < 0 || end < start) {
    throw new Error("MathJax did not return SVG output");
  }
  return markup.slice(start, end + "</svg>".length);
}

function applySvgTextColor(svg: string, color: string): string {
  return svg.replace(/<svg\b([^>]*)>/, (_full, attrs: string) => {
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
    if (!styleMatch) {
      return `<svg${attrs} style="color: ${color};">`;
    }
    const originalStyle = styleMatch[1].trim();
    const nextStyle = originalStyle ? `${originalStyle}; color: ${color};` : `color: ${color};`;
    const attrsWithStyle = attrs.replace(/\sstyle="([^"]*)"/, ` style="${nextStyle}"`);
    return `<svg${attrsWithStyle}>`;
  });
}

function appendTextToken(tokens: DiscordMathToken[], text: string): void {
  if (!text) {
    return;
  }
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === "text") {
    previous.text += text;
    return;
  }
  tokens.push({ kind: "text", text });
}

function findNextOpening(params: {
  text: string;
  fromIndex: number;
  delimiters: DelimiterSpec[];
  isInsideCode: ((index: number) => boolean) | undefined;
}): { index: number; delimiter: DelimiterSpec } | undefined {
  const { text, fromIndex, delimiters, isInsideCode } = params;
  let best:
    | {
        index: number;
        delimiter: DelimiterSpec;
      }
    | undefined;
  for (const delimiter of delimiters) {
    let searchFrom = fromIndex;
    while (searchFrom < text.length) {
      const index = text.indexOf(delimiter.open, searchFrom);
      if (index < 0) {
        break;
      }
      if (!isInsideCode || !isInsideCode(index)) {
        if (!best || index < best.index) {
          best = { index, delimiter };
        }
        break;
      }
      searchFrom = index + 1;
    }
  }
  return best;
}

function findClosingIndex(params: {
  text: string;
  fromIndex: number;
  delimiter: DelimiterSpec;
  isInsideCode: ((index: number) => boolean) | undefined;
}): number {
  const { text, fromIndex, delimiter, isInsideCode } = params;
  let searchFrom = fromIndex;
  while (searchFrom < text.length) {
    const index = text.indexOf(delimiter.close, searchFrom);
    if (index < 0) {
      return -1;
    }
    if (!isInsideCode || !isInsideCode(index)) {
      return index;
    }
    searchFrom = index + 1;
  }
  return -1;
}

function tokenizeMathText(
  text: string,
  config: ResolvedDiscordMathImageConfig,
): DiscordMathToken[] {
  const activeDelimiters = DELIMITER_SPECS.filter((item) => config.delimiters.includes(item.kind));
  if (activeDelimiters.length === 0) {
    return [{ kind: "text", text }];
  }

  const codeIndex = config.excludeCode ? buildCodeSpanIndex(text) : undefined;
  const isInsideCode = codeIndex?.isInside;
  const tokens: DiscordMathToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const opening = findNextOpening({
      text,
      fromIndex: cursor,
      delimiters: activeDelimiters,
      isInsideCode,
    });
    if (!opening) {
      appendTextToken(tokens, text.slice(cursor));
      break;
    }
    if (opening.index > cursor) {
      appendTextToken(tokens, text.slice(cursor, opening.index));
    }

    const expressionStart = opening.index + opening.delimiter.open.length;
    const closeIndex = findClosingIndex({
      text,
      fromIndex: expressionStart,
      delimiter: opening.delimiter,
      isInsideCode,
    });
    if (closeIndex < 0) {
      appendTextToken(tokens, text.slice(opening.index));
      break;
    }

    const expression = text.slice(expressionStart, closeIndex);
    const raw = text.slice(opening.index, closeIndex + opening.delimiter.close.length);
    tokens.push({
      kind: "formula",
      raw,
      expression,
    });
    cursor = closeIndex + opening.delimiter.close.length;
  }

  if (tokens.length === 0) {
    return [{ kind: "text", text }];
  }
  return tokens;
}

export async function buildDiscordMathSegments(
  text: string,
  configInput?: DiscordMathImageConfig,
  deps: BuildDiscordMathSegmentsDeps = {},
): Promise<DiscordMathSegmentResult> {
  const config = resolveDiscordMathImageConfig(configInput);
  if (!config.enabled || !text) {
    return {
      config,
      hasMathImages: false,
      segments: [{ kind: "text", text }],
    };
  }

  const tokens = tokenizeMathText(text, config);
  if (!tokens.some((token) => token.kind === "formula")) {
    return {
      config,
      hasMathImages: false,
      segments: [{ kind: "text", text }],
    };
  }

  const renderFormulaPng = deps.renderFormulaPng ?? renderFormulaPngDefault;
  const segments: DiscordMathSegment[] = [];
  let imageCount = 0;

  for (const token of tokens) {
    if (token.kind === "text") {
      appendMathTextSegment(segments, token.text);
      continue;
    }
    if (imageCount >= config.maxExpressionsPerReply) {
      appendMathTextSegment(segments, token.raw);
      continue;
    }
    if (token.expression.length > config.maxCharsPerExpression) {
      appendMathTextSegment(segments, token.raw);
      continue;
    }
    try {
      const imageBuffer = await renderFormulaPng(token.expression, config.maxImageWidthPx);
      imageCount += 1;
      segments.push({
        kind: "math-image",
        formulaText: token.raw,
        expression: token.expression,
        imageBuffer,
        fileName: `${MATH_IMAGE_NAME_PREFIX}-${imageCount}.png`,
      });
    } catch (error) {
      appendMathTextSegment(segments, token.raw);
      logVerbose(
        `discord math render failed; sent plain text fallback: ${String(error).replace(/\s+/g, " ").trim()}`,
      );
    }
  }

  if (segments.length === 0) {
    return {
      config,
      hasMathImages: false,
      segments: [{ kind: "text", text }],
    };
  }

  return {
    config,
    hasMathImages: segments.some((segment) => segment.kind === "math-image"),
    segments,
  };
}

function appendMathTextSegment(segments: DiscordMathSegment[], text: string) {
  if (!text) {
    return;
  }
  const previous = segments[segments.length - 1];
  if (previous?.kind === "text") {
    previous.text += text;
    return;
  }
  segments.push({ kind: "text", text });
}
