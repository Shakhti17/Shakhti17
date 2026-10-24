import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

export function createMemoryTools(memory) {
  return [
    betaZodTool({
      name: "recall_memory",
      description:
        "Search long-term memory: facts about the user and their business, lessons from past reviews, " +
        "and summaries of earlier requests.",
      inputSchema: z.object({ query: z.string() }),
      run: async ({ query }) => memory.format(memory.search(query, 8)) || "No matching memories.",
    }),
    betaZodTool({
      name: "save_memory",
      description:
        "Save a durable fact the whole team should remember next time (company, product, audience, " +
        "tech stack, brand voice, preferences). Do not save one-off task details.",
      inputSchema: z.object({ fact: z.string() }),
      run: async ({ fact }) => {
        await memory.add("semantic", fact);
        return "Saved.";
      },
    }),
  ];
}
