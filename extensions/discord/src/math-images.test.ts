import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildDiscordMathSegments } from "./math-images.js";

describe("buildDiscordMathSegments", () => {
  it("renders formulas with the default MathJax renderer", async () => {
    const result = await buildDiscordMathSegments("$$x^2$$");

    expect(result.hasMathImages).toBe(true);
    expect(result.segments).toHaveLength(1);
    const segment = result.segments[0];
    expect(segment?.kind).toBe("math-image");
    if (segment?.kind === "math-image") {
      expect(segment.formulaText).toBe("$$x^2$$");
      expect(segment.imageBuffer.length).toBeGreaterThan(0);
      expect(segment.fileName).toMatch(/^equation-\d+\.png$/);

      const { data, info } = await sharp(segment.imageBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let maxChannel = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const alpha = data[i + info.channels - 1] ?? 0;
        if (alpha === 0) {
          continue;
        }
        const red = data[i] ?? 0;
        const green = data[i + 1] ?? 0;
        const blue = data[i + 2] ?? 0;
        maxChannel = Math.max(maxChannel, red, green, blue);
      }
      expect(maxChannel).toBeGreaterThan(170);
    }
  });

  it("renders $$...$$ and \\[...\\] formulas into image segments", async () => {
    const result = await buildDiscordMathSegments("A $$x^2$$ B \\[y+1\\] C", undefined, {
      renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
    });

    expect(result.hasMathImages).toBe(true);
    expect(result.segments.map((segment) => segment.kind)).toEqual([
      "text",
      "math-image",
      "text",
      "math-image",
      "text",
    ]);
    expect(result.segments[1]).toEqual(
      expect.objectContaining({
        kind: "math-image",
        formulaText: "$$x^2$$",
        expression: "x^2",
      }),
    );
    expect(result.segments[3]).toEqual(
      expect.objectContaining({
        kind: "math-image",
        formulaText: "\\[y+1\\]",
        expression: "y+1",
      }),
    );
  });

  it("excludes fenced code and renders formulas outside fences", async () => {
    const text = "```latex\n$$x^2$$\n```\n\n$$y^2$$";
    const result = await buildDiscordMathSegments(text, undefined, {
      renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
    });

    expect(result.hasMathImages).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: "```latex\n$$x^2$$\n```\n\n",
      }),
    );
    expect(result.segments[1]).toEqual(
      expect.objectContaining({
        kind: "math-image",
        formulaText: "$$y^2$$",
      }),
    );
  });

  it("excludes inline code and renders formulas outside inline spans", async () => {
    const text = "Inline `\\[x+1\\]` and \\[y+1\\]";
    const result = await buildDiscordMathSegments(text, undefined, {
      renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
    });

    expect(result.hasMathImages).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual(
      expect.objectContaining({
        kind: "text",
        text: "Inline `\\[x+1\\]` and ",
      }),
    );
    expect(result.segments[1]).toEqual(
      expect.objectContaining({
        kind: "math-image",
        formulaText: "\\[y+1\\]",
      }),
    );
  });

  it("falls back to plain text when rendering fails", async () => {
    const text = "$$\\badcommand$$";
    const result = await buildDiscordMathSegments(text, undefined, {
      renderFormulaPng: async () => {
        throw new Error("bad formula");
      },
    });

    expect(result.hasMathImages).toBe(false);
    expect(result.segments).toEqual([{ kind: "text", text }]);
  });

  it("falls back to plain text for formulas beyond maxExpressionsPerReply", async () => {
    const result = await buildDiscordMathSegments(
      "$$a$$ $$b$$",
      { maxExpressionsPerReply: 1 },
      {
        renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
      },
    );

    expect(result.hasMathImages).toBe(true);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toEqual(
      expect.objectContaining({
        kind: "math-image",
        formulaText: "$$a$$",
      }),
    );
    expect(result.segments[1]).toEqual({
      kind: "text",
      text: " $$b$$",
    });
  });

  it("falls back to plain text for formulas longer than maxCharsPerExpression", async () => {
    const result = await buildDiscordMathSegments(
      "$$abcd$$",
      { maxCharsPerExpression: 3 },
      {
        renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
      },
    );

    expect(result.hasMathImages).toBe(false);
    expect(result.segments).toEqual([{ kind: "text", text: "$$abcd$$" }]);
  });

  it("returns plain text when feature is disabled", async () => {
    const text = "$$x^2$$";
    const result = await buildDiscordMathSegments(
      text,
      { enabled: false },
      {
        renderFormulaPng: async (expression) => Buffer.from(`png:${expression}`),
      },
    );

    expect(result.hasMathImages).toBe(false);
    expect(result.segments).toEqual([{ kind: "text", text }]);
  });
});
