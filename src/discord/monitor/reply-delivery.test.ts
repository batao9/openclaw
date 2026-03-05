import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverDiscordReply } from "./reply-delivery.js";

const sendMessageDiscordMock = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: "msg-1", channelId: "channel-1" })),
);

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
}));

describe("deliverDiscordReply", () => {
  beforeEach(() => {
    sendMessageDiscordMock.mockReset();
    sendMessageDiscordMock.mockResolvedValue({ messageId: "msg-1", channelId: "channel-1" });
  });

  it("resolves relative media paths against workspaceDir", async () => {
    const workspaceDir = "/tmp/workspace-sdb";
    await deliverDiscordReply({
      replies: [{ text: "done", mediaUrl: "./out/discord_verify.txt" }],
      target: "channel:123",
      token: "token",
      accountId: "default",
      workspaceDir,
      mediaLocalRoots: [workspaceDir],
      runtime: {} as RuntimeEnv,
      textLimit: 2000,
    });

    expect(sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123",
      "done",
      expect.objectContaining({
        mediaUrl: path.join(workspaceDir, "out", "discord_verify.txt"),
        mediaLocalRoots: [workspaceDir],
      }),
    );
  });
});
