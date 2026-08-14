# Dissociating Wikipedia Bot

Posts a Bluesky link card pointing at a Wikipedia article about something
trending, with the preview image taken from a completely unrelated article.

Based on a phone bug where the Wikipedia app loads the correct article but the
hero image from whatever you read last.

## Why this works

On most platforms the preview image is server-side: you post a URL, the platform
fetches the page and renders its own card. You'd have no way to swap the image.

Bluesky builds link cards **client-side**. The posting client uploads the
thumbnail blob itself and supplies `uri`, `title`, and `description` as
independent fields of an `app.bsky.embed.external` record. Nothing validates
that the image relates to the link. So this isn't a simulation of the bug — it's
just the normal API.

The card's title and description stay truthful to the linked article on purpose;
the image alone carries the joke. Same mechanism gets abused for phishing, so
it's worth being unambiguous that this is a bit — put "bot" in the account bio.

## Setup

```sh
npm install
cp .env.example .env   # then fill it in
```

You need a Bluesky **app password** (Settings → Privacy and security → App
passwords), not your account password, and an Anthropic API key.

## Running

```sh
npm run dry    # prints the pairing, posts nothing
npm run post   # actually posts
```

Run `npm run dry` a bunch of times first to see whether the juxtapositions are
landing before it touches your account.

## How it works

Five steps, each an exported function in `src/main.ts` so you can call them
individually while iterating:

| Step | Function                | Notes                                         |
| ---- | ----------------------- | --------------------------------------------- |
| 1    | `fetchTrendingTopics()` | Bluesky's trending endpoint                   |
| 2    | `extractEntities()`     | Claude normalizes headlines into entity names |
| 3    | `resolveFirstArticle()` | Wikipedia decides which ones are real         |
| 4    | `pickImageArticle()`    | Random article with a usable lead image       |
| 5    | `postJuxtaposition()`   | Upload blob, post the card                    |

Step 2 is load-bearing, not a nicety. Trending topics arrive as headline
sentences — `"Trump spends $900M on White House"`, not `"Trump"` — and none of
them resolve to an article verbatim. Claude pulls out the candidate subjects;
**Wikipedia**, not Claude, decides whether an article actually exists, because
asking a model that just gets you confident-sounding invented titles.

## Things that will bite you

**The trending endpoint is unspecced.**
`app.bsky.unspecced.getTrendingTopics` is undocumented and may change shape or
disappear without notice. It's still better than scraping a third-party page,
because it fails loudly rather than silently returning junk. `fetchTrendingTopics`
is the single place to fix when it breaks.

**Wikipedia is two hosts with two conflicting policies.**
This one cost real debugging time:

- `en.wikipedia.org/api/rest_v1` (the API) _requires_ a descriptive User-Agent
  with contact info. Generic or missing UAs get rate-limited.
- `upload.wikimedia.org` (the media CDN) **403s any request carrying an
  identifying User-Agent**, including the exact one the API demands.

So the code sends different headers to each host. For the CDN, the default is to
send no identifying UA rather than a fake browser one — `Mozilla/5.0` also works,
but that's circumventing a stated [robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy)
by impersonation, and the policy says clients that route around it may be blocked
outright. Set `WIKIMEDIA_MEDIA_UA` if you want to identify and are running
somewhere the CDN accepts it.

⚠️ **Runtimes send their own default UA.** Node sends `node`, which the CDN
accepts. Deno sends `Deno/x.y.z`, which is untested — check this when you port to
Supabase, because it's a 403 at the last step of the pipeline.

**Don't rewrite thumbnail widths.** The obvious optimization is swapping the
`330px` in the image URL for something wider so the card looks sharper. It
doesn't work: the CDN only serves renditions that already exist, and returns
**400 for any other width — even a smaller one, even a standard size**. The
API-provided URL is the only one guaranteed to be there. This also keeps us to
one CDN request per run, well inside the rate limits.

**Rate limits are real.** The CDN starts returning 429 under sustained load.
`MediaAccessError` is thrown for both 403 and 429 and is deliberately _not_
retried, because retrying is what gets clients blocked.

## Porting to Supabase

Everything runs on `fetch` and web APIs. The runtime-specific parts are isolated
at the top of `src/main.ts`:

- `env()` → `Deno.env.get()`
- `DRY_RUN` / `IS_ENTRYPOINT` → a request handler instead of `process.argv`

Both dependencies work in Deno via `npm:` specifiers. Schedule with `pg_cron`.
Check the Deno default User-Agent against the media CDN before you rely on it.

## Ideas

- Store previous trending topics so the image comes from _the last thing looked
  up_, which is closer to the actual bug.
- Random articles are mostly obscure — a village, a beetle, a footballer.
  Sourcing the image from the most-read list would land the joke more often;
  `pickImageArticle` is the only function that would change.
