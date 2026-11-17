import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const statusOut = z.object({
  running: z.boolean(),
  health: z.boolean(),
  proxy: z.boolean(),
});

export const controlContract = defineRpcContract({
  "gemini.status": { input: z.object({}).strict(), output: statusOut },
  "gemini.start": { input: z.object({}).strict(), output: statusOut },
  "gemini.stop": { input: z.object({}).strict(), output: statusOut },
  "gemini.chats": {
    input: z.object({}).strict(),
    output: z.object({
      data: z.array(z.object({ cid: z.string(), title: z.string(), pinned: z.boolean(), timestamp: z.number() })),
    }),
  },
  "gemini.chatHistory": {
    input: z.object({ cid: z.string() }).strict(),
    output: z.object({ cid: z.string(), turns: z.array(z.object({ role: z.string(), text: z.string() })) }),
  },
  "gemini.continueChat": {
    input: z.object({ cid: z.string(), title: z.string().optional() }).strict(),
    output: z.object({ threadId: z.string().nullable(), error: z.string().nullable() }),
  },
});