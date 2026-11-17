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
});