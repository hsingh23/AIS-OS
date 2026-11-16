// Everything that touches the Google Photos web UI lives here.
// Google changes this DOM often. If a step breaks, run `node cli.mjs probe` and fix SELECTORS only.
export const HOME = process.env.PHOTOS_HOME || "https://photos.google.com/";

export const SELECTORS = {
  gridLink: 'a[href*="/photo/"]',
  infoButton: 'button[aria-label*="info" i], [role="button"][aria-label*="info" i]',
  description: [
    'textarea[aria-label="Description"]',
    'textarea[aria-label*="description" i]',
    'textarea[placeholder*="description" i]',
    '[contenteditable="true"][aria-label*="description" i]',
  ].join(", "),
};

export function photoId(url) {
  const m = String(url).match(/\/photo\/([^/?#]+)/);
  return m ? m[1] : null;
}
export const photoUrl = id => `${HOME}photo/${id}`;

// ---------- enumeration (producer) ----------
// Scrolls the library grid and yields batches of new items until the end is reached.
export async function* enumerateLibrary(page, { idleRounds = 25, startUrl = HOME } = {}) {
  const base = new URL(HOME);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(SELECTORS.gridLink, { timeout: 60_000 });
  const seen = new Set();
  let idle = 0;
  while (idle < idleRounds) {
    const links = await page.$$eval(SELECTORS.gridLink, as =>
      as.map(a => ({ href: a.href, label: a.getAttribute("aria-label") || "" })));
    const fresh = [];
    for (const l of links) {
      const id = l.href.match(/\/photo\/([^/?#]+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      fresh.push({ id, url: new URL(`photo/${id}`, base).href, label: l.label,
                   kind: /^video/i.test(l.label) ? "video" : "photo" });
    }
    idle = fresh.length ? 0 : idle + 1;
    if (fresh.length) yield fresh;
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(fresh.length ? 400 : 1200);
  }
}

// ---------- per-item work ----------
export async function openItem(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (/accounts\.google\.com/.test(page.url())) {
    throw Object.assign(new Error("signed out of Google; run `node cli.mjs login`"), { stage: "auth", fatal: true });
  }
  // Wait for the main media to show up.
  await page.waitForFunction(() => {
    const vis = [...document.querySelectorAll("img, video")].filter(el => {
      const r = el.getBoundingClientRect();
      const loaded = el.tagName === "VIDEO" ? (el.poster || el.readyState > 0) : (el.complete && el.naturalWidth > 0);
      return loaded && Math.max(r.width, r.height) >= 300 && Math.min(r.width, r.height) >= 10 &&
             r.right > 0 && r.left < innerWidth;
    });
    return vis.length > 0;
  }, null, { timeout: 30_000 });
}

// Returns {data(base64), mediaType}. Pulls a 1024px still from Google's image CDN using the
// signed-in session (for videos this is the poster = first frame). Falls back to a screenshot.
export async function grabStill(page) {
  const src = await page.evaluate(() => {
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll("img, video")) {
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const url = el.tagName === "VIDEO" ? el.poster : (el.currentSrc || el.src);
      if (w * h > bestArea && url && /googleusercontent\.com/.test(url)) { bestArea = w * h; best = url; }
    }
    return best;
  });
  if (src) {
    const sized = src.replace(/=[^/]*$/, "") + "=w1024-h1024";
    const res = await page.context().request.get(sized, { timeout: 30_000 });
    if (res.ok()) {
      const mediaType = (res.headers()["content-type"] || "image/jpeg").split(";")[0];
      if (/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
        return { data: (await res.body()).toString("base64"), mediaType, via: "cdn" };
      }
    }
  }
  const buf = await page.screenshot({ type: "jpeg", quality: 70 });
  return { data: buf.toString("base64"), mediaType: "image/jpeg", via: "screenshot" };
}

async function descriptionField(page) {
  const field = page.locator(SELECTORS.description).locator("visible=true").first();
  if (await field.count()) return field;
  // Info panel closed: open it.
  await page.keyboard.press("i");
  try { await field.waitFor({ state: "visible", timeout: 4000 }); return field; } catch {}
  const btn = page.locator(SELECTORS.infoButton).locator("visible=true").first();
  if (await btn.count()) await btn.click();
  await field.waitFor({ state: "visible", timeout: 8000 });
  return field;
}

export async function readDescription(page) {
  const f = await descriptionField(page);
  return (await f.evaluate(el => ("value" in el ? el.value : el.textContent) || "")).trim();
}

// Writes text, waits for the save request that carries it, and checks it succeeded and stuck.
export async function writeDescription(page, text, marker) {
  const f = await descriptionField(page);
  await f.click();
  await f.fill(text);
  const carries = r => {
    if (!/batchexecute/.test(r.url()) || r.request().method() !== "POST") return false;
    const body = r.request().postData() || "";
    let decoded = body; try { decoded = decodeURIComponent(body.replace(/\+/g, " ")); } catch {}
    return decoded.includes(marker);
  };
  const resp = page.waitForResponse(carries, { timeout: 10_000 }).catch(() => null);
  await f.press("Tab"); // blur triggers save
  const r = await resp;
  if (!r) return { ok: false, reason: "no save request carrying the description was seen" };
  if (!r.ok()) return { ok: false, reason: `save request failed: HTTP ${r.status()}` };
  const now = await readDescription(page);
  if (now !== text.trim()) return { ok: false, reason: "description field does not hold the new text after save" };
  return { ok: true };
}
