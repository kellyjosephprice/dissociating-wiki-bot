/**
 * Posts a Bluesky link card pointing at a trending-topic Wikipedia article,
 * with the preview image taken from a completely unrelated one.
 *
 * Bluesky builds link cards client-side: the poster uploads the thumbnail blob
 * and supplies uri/title/description as independent fields, and nothing checks
 * that the image has anything to do with the link. The title and description
 * stay truthful to the linked article on purpose — the image carries the joke.
 *
 * Everything here runs on fetch and web APIs. The only runtime-specific code is
 * env() and parseArgs() at the top, which is what changes for Supabase Edge
 * Functions (Deno.env.get, and a request handler instead of argv).
 */

import { fileURLToPath } from "node:url";
import { AtpAgent } from "@atproto/api";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- runtime glue

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const DRY_RUN = process.argv.includes("--dry-run");

/** So the exported steps can be imported without running the pipeline. */
const IS_ENTRYPOINT = process.argv[1] === fileURLToPath(import.meta.url);

/**
 * Which trending topic to reach for first.
 *
 * `random` (the default) shuffles, so repeated runs don't keep landing on
 * whatever is at the top of the trending list. `trending` preserves Bluesky's
 * ranking and takes the highest-ranked topic that resolves to an article.
 */
export type TopicOrder = "random" | "trending";

const TOPIC_ORDERS: readonly TopicOrder[] = ["random", "trending"];

function parseOrderFlag(argv: string[]): TopicOrder {
  const index = argv.findIndex((a) => a === "--order" || a.startsWith("--order="));
  if (index === -1) return "random";

  const arg = argv[index]!;
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1];

  if (!value || !TOPIC_ORDERS.includes(value as TopicOrder)) {
    throw new Error(
      `--order expects one of: ${TOPIC_ORDERS.join(", ")} (got ${value ?? "nothing"}).`,
    );
  }
  return value as TopicOrder;
}

// ------------------------------------------------------------------- constants

const BSKY_PUBLIC_API = "https://public.api.bsky.app";
const BSKY_SERVICE = "https://bsky.social";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";

/** Bluesky rejects image blobs over ~1MB. Leave headroom. */
const MAX_BLOB_BYTES = 950_000;
/** How many random articles to try before giving up on finding one with an image. */
const RANDOM_ARTICLE_ATTEMPTS = 15;

/**
 * Headers for the REST API on en.wikipedia.org, which *requires* a descriptive
 * User-Agent with contact info. Generic or missing UAs get rate-limited here.
 */
function wikiApiHeaders(): HeadersInit {
  const ua = `dissociating-wikipedia-bot/0.1 (${env("BOT_CONTACT")})`;
  return { "User-Agent": ua, "Api-User-Agent": ua };
}

/**
 * Headers for upload.wikimedia.org (the media CDN), which is a DIFFERENT host
 * with a different and partly conflicting policy.
 *
 * The CDN currently 403s any request carrying an identifying User-Agent —
 * including the descriptive one the REST API demands — while allowing requests
 * with a non-identifying one. Sending a fake browser UA ("Mozilla/5.0") also
 * works, but that is circumventing a stated robot policy by impersonation, and
 * the policy says clients that route around it may be blocked outright. So the
 * default here is to send no identifying UA rather than a false one.
 *
 * We comply with the parts of the policy that describe actual load: one image
 * per run, standard thumbnail widths only, thumbnails preferred over originals,
 * far below the concurrency-2 and 25 Mbps ceilings.
 *
 * Set WIKIMEDIA_MEDIA_UA to override if you'd rather identify (and are running
 * somewhere the CDN accepts it, e.g. Wikimedia Cloud Services).
 * See: https://wikitech.wikimedia.org/wiki/Robot_policy
 */
function mediaHeaders(): HeadersInit {
  const override = process.env["WIKIMEDIA_MEDIA_UA"];
  return override ? { "User-Agent": override } : {};
}

// ----------------------------------------------------------------------- types

export interface Article {
  title: string;
  url: string;
  extract: string;
  /** Scaled-down lead image. Absent on most articles. */
  thumbnailUrl?: string;
}

export interface EntityCandidates {
  topic: string;
  candidates: string[];
}

// ------------------------------------------------------- 1. bluesky trending

/**
 * Fetches current trending topics.
 *
 * NOTE: `unspecced` means exactly what it looks like — this endpoint is
 * undocumented and may change shape or disappear without notice. It is still a
 * better bet than scraping a third-party page, because when it breaks it breaks
 * loudly (bad status / missing field) instead of silently returning junk. This
 * function is the single place to fix when that happens.
 */
export async function fetchTrendingTopics(limit = 25): Promise<string[]> {
  const url = `${BSKY_PUBLIC_API}/xrpc/app.bsky.unspecced.getTrendingTopics?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `getTrendingTopics returned ${res.status} ${res.statusText}. ` +
        `This endpoint is unspecced and may have changed.`,
    );
  }

  const body = (await res.json()) as {
    topics?: Array<{ topic?: string; displayName?: string }>;
  };

  const topics = (body.topics ?? [])
    .map((t) => t.displayName ?? t.topic)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);

  if (topics.length === 0) {
    throw new Error("getTrendingTopics returned no usable topics.");
  }
  return topics;
}

// -------------------------------------------------------- 2. entity extraction

/**
 * Normalizes raw trending topics into candidate Wikipedia article titles.
 *
 * Claude does the fuzzy part (a topic may be a hashtag, a fragment, or a
 * nickname); it deliberately does NOT decide whether an article exists, because
 * it would happily invent plausible titles. Step 3 asks Wikipedia that.
 */
export async function extractEntities(
  topics: string[],
): Promise<EntityCandidates[]> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  topic: { type: "string" },
                  candidates: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
                required: ["topic", "candidates"],
                additionalProperties: false,
              },
            },
          },
          required: ["results"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content:
          `These are trending topics on Bluesky. They arrive as short headline-style ` +
          `phrases rather than bare entity names — for example "Trump spends $900M on ` +
          `White House" or "USS Abraham Lincoln deployment crisis".\n\n` +
          `For each one, give up to 3 candidate English Wikipedia article titles for the ` +
          `people, places, organizations, works, or events the headline is about.\n\n` +
          `Rules:\n` +
          `- Pull out the subject; don't try to title an article after the whole headline. ` +
          `"Trump spends $900M on White House" -> "Donald Trump", "White House".\n` +
          `- Prefer the specific and notable over the generic. For "Twitch trains AI on ` +
          `channel content", "Twitch (service)" is a good candidate and "Artificial ` +
          `intelligence" is a weak one — broad concept articles make dull links.\n` +
          `- Resolve nicknames, initials, and shorthand to the full subject where you are ` +
          `confident ("AOC" -> "Alexandria Ocasio-Cortez").\n` +
          `- Strip hashtags and casing artifacts ("#Eurovision" -> "Eurovision").\n` +
          `- If a headline is conversational chatter with no encyclopedic subject behind ` +
          `it ("Games that didn't click for players"), return an empty candidates array.\n` +
          `- Order candidates most likely first. Guessing at exact titles is fine; each ` +
          `one gets checked against Wikipedia afterward.\n\n` +
          `Return one entry per input topic, with the topic string copied verbatim.\n\n` +
          topics.map((t) => `- ${t}`).join("\n"),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error(
      `Claude returned no text block (stop_reason: ${response.stop_reason}).`,
    );
  }

  const parsed = JSON.parse(textBlock.text) as { results: EntityCandidates[] };
  return parsed.results.filter((r) => r.candidates.length > 0);
}

// ------------------------------------------------------- 3. wikipedia resolve

/** Looks up one exact title. Returns null for 404s and disambiguation pages. */
export async function lookupArticle(title: string): Promise<Article | null> {
  const slug = encodeURIComponent(title.trim().replace(/ /g, "_"));
  const res = await fetch(`${WIKI_REST}/page/summary/${slug}`, {
    headers: wikiApiHeaders(),
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Wikipedia summary for "${title}" returned ${res.status}`);
  }

  const body = (await res.json()) as {
    type?: string;
    title?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
    thumbnail?: { source?: string };
  };

  // "disambiguation" pages are real articles but useless as a target.
  if (body.type !== "standard") return null;

  const url = body.content_urls?.desktop?.page;
  if (!body.title || !url) return null;

  return {
    title: body.title,
    url,
    extract: body.extract ?? "",
    thumbnailUrl: body.thumbnail?.source,
  };
}

/** Fisher-Yates, on a copy — the caller's array is left alone. */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Walks the topics until one resolves to a real article. Returns the first hit,
 * along with the trending topic that produced it.
 *
 * `order: "random"` (the default) shuffles at both levels: the topics, so
 * consecutive runs don't keep posting about whatever is top of the trending
 * list, and the extracted candidates within each topic.
 *
 * Note the second one has a cost. Claude returns candidates most-likely-first
 * ("Alexandria Ocasio-Cortez" ahead of vaguer guesses), and since we take the
 * first candidate that resolves, shuffling means we take a random *resolving*
 * candidate rather than the best one — so a topic can land on a more tangential
 * article than it would otherwise. That's the trade for more variety.
 *
 * `order: "trending"` preserves both orderings.
 */
export async function resolveFirstArticle(
  entities: EntityCandidates[],
  order: TopicOrder = "random",
): Promise<{ topic: string; article: Article } | null> {
  const orderedEntities = order === "random" ? shuffled(entities) : entities;

  for (const entity of orderedEntities) {
    const candidates =
      order === "random" ? shuffled(entity.candidates) : entity.candidates;

    for (const candidate of candidates) {
      const article = await lookupArticle(candidate);
      if (article) return { topic: entity.topic, article };
    }
  }
  return null;
}

// --------------------------------------------------- 4. random image article

/**
 * Pulls random articles until one has a lead image.
 *
 * Most random articles are obscure and many have no image at all, hence the
 * retry loop. Swapping this for the "most-read yesterday" feed is the obvious
 * upgrade when you want the juxtapositions to land more often — it's a
 * different URL and the same return shape.
 */
export async function randomArticleWithImage(): Promise<Article> {
  for (let attempt = 0; attempt < RANDOM_ARTICLE_ATTEMPTS; attempt++) {
    const res = await fetch(`${WIKI_REST}/page/random/summary`, {
      headers: wikiApiHeaders(),
    });
    if (!res.ok) continue;

    const body = (await res.json()) as {
      type?: string;
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      thumbnail?: { source?: string };
    };

    const url = body.content_urls?.desktop?.page;
    if (body.type !== "standard" || !body.title || !url) continue;
    if (!body.thumbnail?.source) continue;

    return {
      title: body.title,
      url,
      extract: body.extract ?? "",
      thumbnailUrl: body.thumbnail.source,
    };
  }

  throw new Error(
    `No random article with a lead image after ${RANDOM_ARTICLE_ATTEMPTS} tries.`,
  );
}

export interface ResolvedImage {
  article: Article;
  bytes: Uint8Array;
  mimeType: string;
}

/**
 * Picks a random article whose lead image we can actually download at a usable
 * size. Some articles advertise a lead image that turns out to be a multi-MB
 * original with no thumbnail rendition available; those get skipped rather than
 * failing the run. A 403 from the CDN is not retried — that's a config problem,
 * and hammering it is exactly what the robot policy warns about.
 */
export async function pickImageArticle(attempts = 5): Promise<ResolvedImage> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const article = await randomArticleWithImage();
    try {
      const { bytes, mimeType } = await fetchThumbnailBytes(
        article.thumbnailUrl!,
      );
      return { article, bytes, mimeType };
    } catch (error) {
      if (error instanceof MediaAccessError) throw error;
      lastError = error;
    }
  }

  throw new Error(
    `No usable lead image after ${attempts} articles. Last error: ${
      lastError instanceof Error ? lastError.message : lastError
    }`,
  );
}

// -------------------------------------------------------------- 5. post to bsky

/**
 * The CDN refused or throttled us. Retrying with a different article won't
 * help, and hammering it is what the robot policy warns about.
 */
export class MediaAccessError extends Error {}

/**
 * Downloads an article's lead image.
 *
 * Deliberately fetches the exact URL the summary API returned, with no width
 * rewriting. It's tempting to swap the "330px" in the path for something wider
 * so the link card looks sharper, but the CDN only serves renditions that
 * already exist — asking for any other width returns 400, even a smaller one,
 * and even a "standard" size. The API-provided URL is the one that's guaranteed
 * to be there, and one request per article keeps us well inside the rate limits.
 */
export async function fetchThumbnailBytes(
  thumbnailUrl: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const res = await fetch(thumbnailUrl, { headers: mediaHeaders() });

  if (res.status === 403 || res.status === 429) {
    const what = res.status === 403 ? "blocked" : "rate-limited";
    throw new MediaAccessError(
      `upload.wikimedia.org ${what} the thumbnail request (${res.status}).\n` +
        (res.status === 403
          ? `The media CDN rejects requests carrying an identifying User-Agent, and\n` +
            `will also reject a runtime default UA that looks automated. Current\n` +
            `WIKIMEDIA_MEDIA_UA: ${process.env["WIKIMEDIA_MEDIA_UA"] ?? "<unset>"}.\n`
          : `Back off before retrying.\n`) +
        `See https://wikitech.wikimedia.org/wiki/Robot_policy`,
    );
  }

  if (!res.ok) {
    throw new Error(`Thumbnail fetch returned ${res.status}.`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BLOB_BYTES) {
    // Usually means thumbnail.source was an original file rather than a
    // rendition. Caller skips to another article.
    throw new Error(
      `Lead image is ${Math.round(bytes.byteLength / 1024)}kb, over the ` +
        `${Math.round(MAX_BLOB_BYTES / 1024)}kb blob limit.`,
    );
  }

  return {
    bytes,
    mimeType: res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg",
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function postJuxtaposition(
  linkArticle: Article,
  image: ResolvedImage,
): Promise<{ uri: string }> {
  const agent = new AtpAgent({ service: BSKY_SERVICE });
  await agent.login({
    identifier: env("BLUESKY_HANDLE"),
    password: env("BLUESKY_APP_PASSWORD"),
  });

  const upload = await agent.uploadBlob(image.bytes, {
    encoding: image.mimeType,
  });

  const result = await agent.post({
    text: truncate(linkArticle.title, 300),
    createdAt: new Date().toISOString(),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: linkArticle.url,
        title: linkArticle.title,
        description: truncate(linkArticle.extract, 300),
        thumb: upload.data.blob,
      },
    },
  });

  return { uri: result.uri };
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  const order = parseOrderFlag(process.argv);

  console.log("Fetching trending topics…");
  const topics = await fetchTrendingTopics();
  console.log(`  ${topics.length} topics: ${topics.slice(0, 8).join(", ")}…`);

  console.log("Normalizing topics into entity candidates…");
  const entities = await extractEntities(topics);
  console.log(
    `  ${entities.length} topics look like they have a subject behind them`,
  );

  console.log(`Resolving against Wikipedia (${order} order)…`);
  const resolved = await resolveFirstArticle(entities, order);
  if (!resolved) {
    throw new Error(
      "No trending topic resolved to a Wikipedia article this run.",
    );
  }
  console.log(`  "${resolved.topic}" -> ${resolved.article.title}`);

  console.log("Finding a random article with a usable lead image…");
  const image = await pickImageArticle();
  const kb = Math.round(image.bytes.byteLength / 1024);
  console.log(`  ${image.article.title} (${image.mimeType}, ${kb}kb)`);

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`  trending topic : ${resolved.topic}`);
  console.log(`  link           : ${resolved.article.title}`);
  console.log(`                   ${resolved.article.url}`);
  console.log(`  preview image  : ${image.article.title}`);
  console.log(`                   ${image.article.url}`);
  console.log("──────────────────────────────────────────────");
  console.log("");

  if (DRY_RUN) {
    console.log("Dry run — nothing posted. Drop --dry-run to post for real.");
    return;
  }

  console.log("Posting…");
  const { uri } = await postJuxtaposition(resolved.article, image);
  console.log(`Posted: ${uri}`);
}

if (IS_ENTRYPOINT) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
