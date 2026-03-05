import type { RequestClient } from "@buape/carbon";
import path from "node:path";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord } from "../send.js";

const HTTP_URL_RE = /^https?:\/\//i;
const FILE_URL_RE = /^file:\/\//i;
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/;

function resolveWorkspaceRelativeMediaUrl(mediaUrl: string, workspaceDir?: string): string {
  const trimmed = mediaUrl.trim();
  if (!trimmed || !workspaceDir) {
    return mediaUrl;
  }
  if (
    HTTP_URL_RE.test(trimmed) ||
    FILE_URL_RE.test(trimmed) ||
    path.isAbsolute(trimmed) ||
    WINDOWS_ABS_RE.test(trimmed) ||
    trimmed.startsWith("~")
  ) {
    return mediaUrl;
  }
  return path.resolve(workspaceDir, trimmed);
}

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  workspaceDir?: string;
  mediaLocalRoots?: readonly string[];
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  for (const payload of params.replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    const replyTo = params.replyToId?.trim() || undefined;

    if (mediaList.length === 0) {
      let isFirstChunk = true;
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) {
          continue;
        }
        await sendMessageDiscord(params.target, trimmed, {
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          mediaLocalRoots: params.mediaLocalRoots,
          replyTo: isFirstChunk ? replyTo : undefined,
        });
        isFirstChunk = false;
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }
    const firstMediaResolved = resolveWorkspaceRelativeMediaUrl(firstMedia, params.workspaceDir);
    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMediaResolved,
      accountId: params.accountId,
      mediaLocalRoots: params.mediaLocalRoots,
      replyTo,
    });
    for (const extra of mediaList.slice(1)) {
      const extraResolved = resolveWorkspaceRelativeMediaUrl(extra, params.workspaceDir);
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extraResolved,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
      });
    }
  }
}
