// Minimal stand-in for photos.google.com used by test/e2e.sh. Not Google's real DOM.
// Grid with infinite scroll, photo pages with an info panel ("i") holding a Description textarea,
// saves via POST /_/batchexecute on blur. Some items start with a user description; a few fail randomly once.
import http from "node:http";

const N = Number(process.env.MOCK_N || 120);
const items = Array.from({ length: N }, (_, i) => ({
  id: `AF1Qip${String(i).padStart(5, "0")}`,
  kind: i % 7 === 0 ? "Video" : "Photo",
  desc: i % 11 === 0 ? "my own note" : "",
}));
const flaky = new Set(items.filter((_, i) => i % 13 === 5).map(x => x.id));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const grid = `<!doctype html><body style="margin:0"><div id=g></div><script>
let next=0;const g=document.getElementById('g');
async function more(){const r=await fetch('/_/page?from='+next);const a=await r.json();
 for(const it of a){const el=document.createElement('a');el.href='./photo/'+it.id;el.setAttribute('aria-label',it.kind+' - Landscape');
  el.style.cssText='display:inline-block;width:200px;height:200px;background:#ccc;margin:4px';g.appendChild(el);}next+=a.length;}
more();addEventListener('scroll',()=>{if(innerHeight+scrollY>document.body.scrollHeight-400)more();});
</script></body>`;

const photo = it => `<!doctype html><body style="margin:0;background:#000">
<img src="/img/${it.id}" style="width:900px;height:700px">
<aside id=info style="display:none"><textarea aria-label="Description">${it.desc}</textarea></aside><script>
addEventListener('keydown',e=>{if(e.key==='i')document.getElementById('info').style.display='block'});
document.querySelector('textarea').addEventListener('blur',e=>fetch('/_/batchexecute?id=${it.id}',{method:'POST',body:e.target.value}));
</script></body>`;

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/") return res.end(grid);
  if (u.pathname === "/_/page") {
    const from = Number(u.searchParams.get("from"));
    return res.end(JSON.stringify(items.slice(from, from + 30)));
  }
  if (u.pathname.startsWith("/img/")) { res.setHeader("content-type", "image/png"); return res.end(PNG); }
  const m = u.pathname.match(/^\/photo\/(.+)$/);
  if (m) {
    const it = items.find(x => x.id === m[1]);
    if (!it) { res.statusCode = 404; return res.end("nope"); }
    if (flaky.delete(it.id)) { res.setHeader("content-type", "text/html"); return res.end("<body>temporarily broken</body>"); }
    res.setHeader("content-type", "text/html");
    return res.end(photo(it));
  }
  if (u.pathname === "/_/batchexecute" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    return req.on("end", () => { items.find(x => x.id === u.searchParams.get("id")).desc = body; res.end("ok"); });
  }
  if (u.pathname === "/_/dump") return res.end(JSON.stringify(items));
  res.statusCode = 404; res.end();
}).listen(Number(process.env.MOCK_PORT || 8765), () => console.log("mock up"));
