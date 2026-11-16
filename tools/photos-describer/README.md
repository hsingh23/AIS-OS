# Google Photos describer

Writes a searchable AI description into every photo and video in your Google Photos library. Videos are described from their first frame. Google Photos search indexes the description field, so afterwards you can type words like "receipt", "whiteboard" or "beach sunset" and find the item.

## Why a browser and not the API

- Since March 2025 the Google Photos Library API can only read and edit items that the app itself uploaded. It can't touch your existing library.
- So this drives photos.google.com in a real Chrome window that you sign in to once, with 10 tabs in parallel.
- It has to run on your computer. A cloud session has no Google login.

## Setup (once)

```bash
cd tools/photos-describer
npm install
export ANTHROPIC_API_KEY=...          # or `ant auth login`
node cli.mjs login                    # Chrome opens. Sign in to Google Photos, then close the window.
```

The login lives in `tools/photos-describer/.chrome-profile/`, which is git-ignored. It doesn't touch your normal Chrome profile.

## Run

```bash
node cli.mjs probe --n 3              # dry check on 3 items: prints what it would write, writes nothing
node cli.mjs run --tabs 10 --dry-run  # full pipeline, no writes (optional)
node cli.mjs run --tabs 10            # the real thing
```

While it runs, from a second terminal:

```bash
node cli.mjs status                   # counts, items/min, ETA, errors by stage, latest advisor notes
node cli.mjs set concurrency 14       # live knobs: concurrency | throttle_ms | paused | max_attempts
node cli.mjs set paused 1
node cli.mjs export > descriptions.csv
```

`Ctrl-C` stops after the current items finish. Re-running `run` resumes where it left off.

## How it works

| Piece | What it does |
|---|---|
| Producer tab | Scrolls the library grid and queues every item. Workers start on the first batch. |
| 10 worker tabs | Claim an item, open it, skip it if it already has a description, fetch a 1024px still (a video's first frame), describe it, type the description, wait for Google's save call. |
| `claude-haiku-5-5` | Vision model at low effort. Returns a caption, 8-20 tags and any visible text. About $0.0002 per item. |
| Meta advisor | Every 5 min, `claude-opus-5-5` reads the stats and error log. It explains what's slowing things down and changes concurrency, throttle or pause right away, within hard limits. |
| `state/queue.sqlite` | Bookkeeping and pub/sub. `items` is the queue (queued, claimed, done, skipped, failed), `events` is an append-only log any process can tail, and `control` holds the live knobs. |

Descriptions look like this:

`[ai] A handwritten grocery list on a kitchen counter | Tags: list, paper, kitchen, indoor, handwriting | Text: eggs, milk, basil`

## Safety rules built in

- It never overwrites a description you wrote. With `--overwrite` it only rewrites ones that start with `[ai]`.
- It never names or guesses identities of people.
- Each tab waits about 1.5 s between items (`throttle_ms`), with jitter. If Google starts erroring, the advisor slows things down. If you get signed out, the run stops with a fatal error.

## Speed

Expect about 6-10 s per item per tab including Google page loads, so 10 tabs do roughly 60-100 items/min, or 4-6k per hour. Check `status` after 10 minutes for your real ETA. Going much above 15 tabs risks Google rate-limiting the account.

## If Google changed the page

Every DOM selector is in `lib/gphotos.mjs` under `SELECTORS`. Run `probe`. On failure it saves screenshots to `state/`, so fix the selector and re-run.

## Test

`./test/e2e.sh` runs the whole pipeline against a local mock of the Photos UI, with no Google account and no model calls. It covers 10 tabs, skip rules, video tagging and retrying flaky pages.
