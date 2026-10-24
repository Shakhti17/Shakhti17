// Marketing Manager tools: a content/SEO checker and a UTM link builder.
// Measurable checks happen in code so the model can iterate on real numbers.
import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Readability and SEO metrics for a piece of Markdown copy. Pure; unit-tested. */
export function analyzeContent(text, keyword = "") {
  const body = text.replace(/```[\s\S]*?```/g, " ");
  const lines = body.split("\n");
  const title = (lines.find((l) => /^#\s/.test(l)) ?? "").replace(/^#\s+/, "").trim();
  const headings = lines.filter((l) => /^#{2,6}\s/.test(l)).length;
  const prose = body.replace(/^#+\s.*$/gm, " ").replace(/[*_`>\[\]()#-]/g, " ");
  const words = prose.match(/[A-Za-z0-9'’]+/g) ?? [];
  const sentences = Math.max(1, (prose.match(/[.!?]+(\s|$)/g) ?? []).length);
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const wordCount = words.length;
  const flesch = wordCount ? 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount) : 0;

  let keywordCount = 0;
  if (keyword.trim()) {
    const escaped = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    keywordCount = (body.match(new RegExp(`\\b${escaped}\\b`, "gi")) ?? []).length;
  }
  const density = wordCount ? (keywordCount / wordCount) * 100 : 0;

  const flags = [];
  if (!title) flags.push("No H1 title (a line starting with '# ').");
  else if (title.length > 60) flags.push(`Title is ${title.length} chars; keep it under 60 for search results.`);
  if (wordCount > 300 && headings === 0) flags.push("Long copy with no subheadings; add H2s to make it scannable.");
  if (flesch < 50) flags.push("Hard to read (Flesch < 50); use shorter sentences and simpler words.");
  if (keyword.trim()) {
    if (keywordCount === 0) flags.push(`Target keyword "${keyword}" does not appear.`);
    else if (density > 3) flags.push(`Keyword density ${density.toFixed(1)}% looks like stuffing; aim for 0.5-2.5%.`);
    if (title && !title.toLowerCase().includes(keyword.toLowerCase())) flags.push("Target keyword is not in the title.");
  }

  return {
    title,
    title_length: title.length,
    words: wordCount,
    sentences,
    avg_sentence_length: Number((wordCount / sentences).toFixed(1)),
    headings,
    flesch_reading_ease: Number(flesch.toFixed(1)),
    reading_time_minutes: Math.max(1, Math.round(wordCount / 230)),
    keyword: keyword || null,
    keyword_count: keywordCount,
    keyword_density_percent: Number(density.toFixed(2)),
    flags,
  };
}

/** Add UTM parameters to a landing-page URL. */
export function buildUtmUrl({ url, source, medium, campaign, content, term }) {
  const u = new URL(url);
  const params = { utm_source: source, utm_medium: medium, utm_campaign: campaign, utm_content: content, utm_term: term };
  for (const [key, value] of Object.entries(params)) {
    if (value) u.searchParams.set(key, value.trim().toLowerCase().replace(/\s+/g, "-"));
  }
  return u.toString();
}

export function createMarketingTools() {
  return [
    betaZodTool({
      name: "content_check",
      description:
        "Measure readability and on-page SEO of Markdown copy (title length, word count, Flesch score, " +
        "headings, keyword density) and get concrete flags. Run it on drafts before delivering them.",
      inputSchema: z.object({
        text: z.string(),
        target_keyword: z.string().optional(),
      }),
      run: async ({ text, target_keyword }) => JSON.stringify(analyzeContent(text, target_keyword ?? ""), null, 2),
    }),
    betaZodTool({
      name: "build_utm_links",
      description: "Create UTM-tagged campaign links for each channel so results can be tracked in analytics.",
      inputSchema: z.object({
        links: z.array(
          z.object({
            url: z.string(),
            source: z.string().describe("e.g. linkedin, newsletter, google"),
            medium: z.string().describe("e.g. social, email, cpc"),
            campaign: z.string(),
            content: z.string().optional(),
            term: z.string().optional(),
          }),
        ),
      }),
      run: async ({ links }) =>
        links
          .map((l) => {
            try {
              return `${l.source}/${l.medium}: ${buildUtmUrl(l)}`;
            } catch {
              return `${l.source}/${l.medium}: Error: "${l.url}" is not a valid URL`;
            }
          })
          .join("\n"),
    }),
  ];
}
