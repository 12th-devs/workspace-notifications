import {mailDate} from './NotificationData.sys.mjs';
// WorkspaceNotificationsChild.sys.mjs — content-process adapters.
// Runs inside web content via JSWindowActor. Only scans after chrome
// explicitly activates a source for this browsing context.

const SCAN_DEBOUNCE_MS = 500;
const MAX_ITEMS = 50;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(36)).slice(-8);
}

function textOf(el, max = 220) {
  if (!el) return "";
  const t = (el.textContent || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

function githubRepoFromHref(href) {
  try {
    const m = new URL(href).pathname.match(/^\/([^/]+\/[^/]+?)(?:\/|$)/);
    if (m && !/^(notifications|search|login|session|settings|orgs|new)$/i.test(m[1].split("/")[0])) return m[1];
  } catch (_e) {}
  return "";
}

function githubNumberFromHref(href) {
  try {
    const path = new URL(href).pathname;
    const m = path.match(/\/(?:issues|pull|discussions|releases|commit|actions\/runs|security\/advisories)\/([A-Za-z0-9]+)/i);
    if (m) return m[1].slice(0, 12);
    const t = path.match(/\/(\d+)(?:\/|$|\?)/);
    if (t) return t[1];
  } catch (_e) {}
  return "";
}

// New GitHub inbox rows concatenate repo, issue number, dates, comment
// counts and subscription state into one text node. Keep only the issue
// title; repo/number move into the detail line.
function cleanGitHubTitle(raw, repo, number) {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (repo) {
    s = s.replace(new RegExp("\\b" + esc(repo) + "\\b", "gi"), " ");
    const short = repo.split("/")[1] || "";
    if (short && short.length > 2) s = s.replace(new RegExp("\\b" + esc(short) + "\\b", "g"), " ");
  }
  if (number) s = s.replace(new RegExp("#" + esc(String(number)) + "\\b", "g"), " ");
  s = s
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, ?\d{4})?\b/gi, " ")
    .replace(/\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, " ")
    .replace(/\bjust now\b/gi, " ")
    .replace(/\+\s*\d+\b/g, " ")
    .replace(/\bsubscribed\b/gi, " ")
    .replace(/\bunsubscribed\b/gi, " ")
    .replace(/\bmark (?:as read|read)\b/gi, " ")
    .replace(/\s{2,}/g, " ").trim()
    .replace(/^[-–—:|/\\,;·]+/, "").trim()
    .replace(/[-–—:|/\\,;·]+$/, "").trim()
    .replace(/\s{2,}/g, " ").trim();
  return s.slice(0, 160);
}

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch (_e) {
    return "";
  }
}

function isHttpsHttpUrl(u) {
  return typeof u === "string" && /^https:\/\//i.test(u);
}

// ---------------------------------------------------------------- service routing

function detectService(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_e) {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || "/";
  if (host === "mail.google.com" || host.endsWith(".mail.google.com")) return "gmail";
  if (host === "calendar.google.com" || host.endsWith(".calendar.google.com")) return "calendar";
  if (host === "github.com") return "github";
  if (/^(www\.)?google\.[a-z.]+$/i.test(host) || host.endsWith(".google.com")) {
    if (path.startsWith("/search")) return "scores";
    return null;
  }
  return null;
}

function canonicalListKey(service, url) {
  try {
    const u = new URL(url);
    if (service === "gmail") {
      // Account + view (inbox/starred/label/...). Hash carries the view.
      const m = (u.hash || "").match(/#(inbox|starred|snoozed|sent|drafts|all|spam|trash|label\/[^/?]+|[a-z-]+)/i);
      const view = m ? m[1].toLowerCase() : "inbox";
      const acct = u.pathname.match(/\/mail\/u\/(\d+)/);
      return "gmail:u/" + (acct ? acct[1] : "0") + "#" + view;
    }
    if (service === "github") return "github:unread-inbox-v3";
    if (service === "calendar") {
      return "calendar:events-v2:" + (u.pathname + u.search).slice(0, 120);
    }
    if (service === "scores") {
      return "scores:search:" + fnv1a(u.searchParams.get("q") || u.href);
    }
  } catch (_e) {}
  return service + ":" + String(url).slice(0, 120);
}

// ---------------------------------------------------------------- gmail

function gmailThreadId(row, doc) {
  const attrs = ["data-legacy-thread-id", "data-thread-id", "data-legacy-message-id", "data-message-id"];
  for (const a of attrs) {
    const v = row.getAttribute?.(a) || row.querySelector?.("[" + a + "]")?.getAttribute(a);
    if (v) return v;
  }
  const link = row.querySelector
    ? row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"], a[href*="#label/"]')
    : null;
  if (link) {
    const href = link.getAttribute("href") || "";
    const m = href.match(/#(?:inbox|all|sent|starred|label)[^/]*\/([a-zA-Z0-9]+)/);
    if (m) return m[1];
    const full = absUrl(href, doc.baseURI);
    if (full) return "url-" + fnv1a(full);
  }
  const sender = textOf(row.querySelector("span[email], td.yX, span.yP, span.zF, b, strong"), 80);
  const subj = textOf(row.querySelector("span.bog, span.bqe"), 120);
  return "hash-" + fnv1a(sender + "|" + subj);
}

function gmailIsUnread(row) {
  if (!row || !row.classList) return false;
  if (row.classList.contains("zE")) return true;
  if (row.classList.contains("yO")) return false;
  if (row.getAttribute("data-is-read") === "false") return true;
  const aria = (row.getAttribute("aria-label") || "").toLowerCase();
  if (/unread|non lu|no le/.test(aria)) return true;
  return false; // Bold snippets and subjects do not establish unread state.
}

function gmailMessageTime(row) {
  const date = row.querySelector("td.xW span, span.bq3, time");
  const label = textOf(date, 80);
  for (const raw of [date?.getAttribute("data-time"), row.getAttribute("data-time"), date?.getAttribute("datetime"), date?.getAttribute("title"), date?.getAttribute("data-tooltip"), date?.getAttribute("aria-label"), label]) {
    const time = mailDate(raw);
    if (time.ts) return {...time, label};
  }
  return {ts:0, precision:"unknown", label};
}

function scanGmail(doc) {
  const selectors = ["tr.zA", 'tr[role="row"]', "div[role='row']", "[data-legacy-thread-id]", "[data-thread-id]"];
  let rows = [];
  for (const sel of selectors) {
    try {
      rows = Array.from(doc.querySelectorAll(sel));
    } catch (_e) {
      rows = [];
    }
    if (rows.length) break;
  }
  const main = doc.querySelector('div[role="main"]');
  const busy = doc.querySelector('[aria-busy="true"], [role="progressbar"]');
  const inboxView = /^#(?:inbox(?:\/|$)|$)/.test(doc.location?.hash || '');
  const ready = inboxView && !busy && (rows.length > 0 || (!!main && !!main.querySelector('[role="grid"]')));
  if (!ready) {
    return { ready: false, items: [], meta: { rows: rows.length, reason: 'Open the Gmail inbox to refresh unread mail' } };
  }
  const signin = /accounts\.google\.com|sign in/i.test(doc.title || "") && rows.length === 0;
  const items = [];
  for (const row of rows) {
    if (!gmailIsUnread(row)) continue;
    const senderEl =
      row.querySelector("span[email]") ||
      row.querySelector("td.yX span.yP, td.yX span.zF, span.bA4 span");
    const sender = senderEl
      ? (senderEl.getAttribute("name") || senderEl.textContent || "").trim().slice(0, 120) || "Unknown"
      : textOf(row.querySelector("b, strong"), 120) || "Unknown";
    const subject = textOf(row.querySelector("span.bog, span.bqe"), 160) || "(No subject)";
    const snippet = textOf(row.querySelector("span.y2, span.Zt"), 200).replace(/^-/, "").trim();
    const time = gmailMessageTime(row);
    const date = time.label;
    let link = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"], a[href*="#label/"]');
    const id = gmailThreadId(row, doc);
    let url = link ? absUrl(link.getAttribute("href") || "", doc.baseURI) : "";
    if (!url && /^[a-f0-9]{10,32}$/i.test(id)) {
      const base = new URL(doc.baseURI); base.hash = "inbox/" + id; url = base.href;
    }
    const fingerprint = fnv1a(sender + "|" + subject + "|" + snippet + "|" + (time.ts || ""));
    items.push({
      id: "gmail:" + id,
      summary: sender + " — " + subject,
      detail: snippet || date || "",
      url,
      ts: time.ts,
      fingerprint,
      meta: { sender, subject, date, unread:true, precision:time.precision, sourceRank:rows.indexOf(row) },
    });
  }
  return {
    ready: true,
    signin,
    items:items.sort((a,b)=>b.ts-a.ts || a.meta.sourceRank-b.meta.sourceRank).slice(0,MAX_ITEMS),
    meta: { rows: rows.length, unread: items.length, readIds:rows.filter(row=>row.classList.contains("yO") || row.getAttribute("data-is-read") === "true").map(row=>"gmail:"+gmailThreadId(row,doc)) },
  };
}

function parseGmailAtom(xml, doc, feedUrl) {
  const feed = new doc.defaultView.DOMParser().parseFromString(xml, 'application/xml');
  if (feed.documentElement?.localName !== 'feed' || feed.querySelector('parsererror')) throw new Error('Not an Atom feed');
  const value = (node, name) => (node.getElementsByTagNameNS('*', name)[0]?.textContent || '').trim();
  const items = Array.from(feed.getElementsByTagNameNS('*', 'entry')).map((entry,sourceRank) => {
    const id = value(entry,'id'), subject = value(entry,'title') || '(No subject)';
    const sender = value(entry,'name') || value(entry,'email') || 'Unknown';
    const detail = value(entry,'summary').slice(0,200);
    const link = Array.from(entry.getElementsByTagNameNS('*','link')).find(n => !n.getAttribute('rel') || n.getAttribute('rel') === 'alternate');
    const url = absUrl(link?.getAttribute('href') || '', feedUrl);
    const date = value(entry,'issued') || value(entry,'published') || value(entry,'modified') || value(entry,'updated');
    const ts = Date.parse(date);
    return {id:'gmail:atom:'+fnv1a(id || url+'|'+subject), summary:(sender+' — '+subject).slice(0,240), detail, ts:Number.isFinite(ts) ? ts : 0, url:isHttpsHttpUrl(url) && new URL(url).hostname === 'mail.google.com' ? url : '', fingerprint:fnv1a(id+'|'+subject+'|'+detail+'|'+date), meta:{sender,subject,date,unread:true,precision:Number.isFinite(ts)?'time':'unknown',sourceRank}};
  });
  return {ready:true, items:items.sort((a,b)=>b.ts-a.ts || a.meta.sourceRank-b.meta.sourceRank).slice(0,MAX_ITEMS), meta:{mode:'atom', unread:value(feed.documentElement,'fullcount') ? Number(value(feed.documentElement,'fullcount')) : items.length}};
}

// ---------------------------------------------------------------- github

function scanGitHub(doc, url) {
  const u = new URL(url);
  if (u.hostname !== "github.com" || !u.pathname.startsWith("/notifications")) return {ready:false, items:[], meta:{mode:"inbox",reason:"Open the GitHub notification inbox"}};
  if (doc.querySelector('form[action="/session"], a[href^="/login?return_to="]') && !doc.querySelector('[data-notification-id], .notification-list-item')) return {ready:false,signin:true,items:[],meta:{mode:"inbox"}};
  const rows=Array.from(doc.querySelectorAll('[data-notification-id], [data-thread-id], .notification-list-item, [id^="notification_"], [data-testid="notification-row"]'));
  const filtered=/is:unread/i.test(u.searchParams.get('query') || u.searchParams.get('q') || '');
  const seen=new Set(), items=[];
  for(const [sourceRank,row] of rows.entries()) {
    if(row.getAttribute('data-unread') === 'false' || row.getAttribute('data-read') === 'true' || row.classList.contains('read'))continue;
    if(!filtered && !row.classList.contains('unread') && !row.classList.contains('js-notification-unread') && row.getAttribute('data-unread') !== 'true')continue;
    const link=row.querySelector('a.notification-list-item-link, a[data-testid="notification-link"], a[href*="/notifications/threads/"], a[href*="/issues/"], a[href*="/pull/"], a[href*="/discussions/"], a[href*="/releases/"], a[href*="/commit/"], a[href*="/security/"], a[href*="/actions/runs/"]');
    const href=absUrl(link?.getAttribute('href') || '',url);
    if(!href || new URL(href).origin !== 'https://github.com')continue;
    const rawTitle=textOf(row.querySelector('.notification-list-item-title, [data-testid="notification-title"], a[data-hovercard-type="issue"], a[data-hovercard-type="pull-request"], a[data-hovercard-type="discussion"], strong, h3, h4') || link,220);
    if(!rawTitle)continue;
    const thread=row.getAttribute('data-notification-id') || row.getAttribute('data-thread-id') || row.id?.replace(/^notification_/, '') || fnv1a(href);
    const id='github:thread:'+thread;
    if(seen.has(id))continue;seen.add(id);
    const date=row.querySelector('relative-time, time'),ts=Date.parse(date?.getAttribute('datetime') || '');
    const repo=textOf(row.querySelector('.notification-list-item-repo, [data-testid="notification-repository"], a[data-hovercard-type="repository"]'),120) || githubRepoFromHref(href);
    const number=githubNumberFromHref(href);
    const title=cleanGitHubTitle(rawTitle,repo,number) || cleanGitHubTitle(textOf(row,220),repo,number) || rawTitle.slice(0,160);
    if(!title)continue;
    const reason=textOf(row.querySelector('.notification-list-item-reason, [data-testid="notification-reason"]'),80);
    const repoRef=repo ? repo+(number ? ' #'+number : '') : (number ? '#'+number : '');
    const detail=[repoRef,reason].filter(Boolean).join(' · ');
    items.push({id,summary:title,detail,url:href,ts:Number.isFinite(ts)?ts:0,fingerprint:fnv1a(id+'|'+title+'|'+detail+'|'+(Number.isFinite(ts)?ts:'')),meta:{unread:true,sourceRank}});
  }
  const empty=/all caught up|no notifications|no unread/i.test(textOf(doc.querySelector('main, [role="main"]'),4000));
  return {ready:rows.length>0 || empty,items:items.sort((a,b)=>b.ts-a.ts || a.meta.sourceRank-b.meta.sourceRank).slice(0,MAX_ITEMS),meta:{mode:"inbox",rows:rows.length,unread:items.length}};
}

// ---------------------------------------------------------------- scores (google)

function pageText(doc, max) {
  try {
    const t = doc.body ? doc.body.innerText || doc.body.textContent || "" : "";
    const s = String(t).replace(/\s+/g, " ").trim();
    return s.slice(0, max || 20000);
  } catch (_e) {
    return "";
  }
}

function findStatusToken(text) {
  if (!text) return "";
  const m = String(text).match(/Q[1-4]\s*[-–]?\s*\d{1,2}:\d{2}|OT\s*\d{1,2}:\d{2}|\bFinal(?:\/OT)?\b|\bHalf(?:time)?\b|\bLIVE\b|\b1st\b|\b2nd\b|\b3rd\b|\b4th\b/gi);
  if (!m) return "";
  // Prefer a live-clock token over a bare ordinal.
  for (const tok of m) {
    if (/Q[1-4]|OT|Final|Half|LIVE/i.test(tok)) return tok.replace(/\s+/g, " ").trim().slice(0, 24);
  }
  return m[0].replace(/\s+/g, " ").trim().slice(0, 24);
}

function expandTeamName(short, text) {
  const s = String(short || "").trim();
  if (!s || !text) return s;
  const last = s.split(/\s+/).pop();
  if (!last) return s;
  try {
    const re = new RegExp("([A-Z][A-Za-z.'-]*\\s+" + last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "g");
    const counts = new Map();
    let m;
    while ((m = re.exec(text))) {
      const cand = m[1].trim().slice(0, 48);
      counts.set(cand, (counts.get(cand) || 0) + 1);
    }
    let best = "";
    let bestN = 0;
    for (const [k, v] of counts) {
      if (v > bestN) { best = k; bestN = v; }
    }
    return best || s;
  } catch (_e) {
    return s;
  }
}

// Read logos already rendered in the connected card; never guess a team's identity.
function scoreTeamName(container) {
  if (!container) return "";
  const pieces = [];
  const walk = node => {
    if (node.nodeType === 3) {
      const value = String(node.textContent || "").replace(/\([^)]*\)/g, "").trim();
      if (value.length > 1 && /^[\p{L} .&'’-]+$/u.test(value)) pieces.push(value);
    } else for (const child of node.childNodes || []) walk(child);
  };
  walk(container);
  const value = (pieces.length ? pieces.sort((a,b) => b.length-a.length)[0] : textOf(container,100)).replace(/\([^)]*\)/g, "").trim();
  // Some variants flatten the short and long name into one text node.
  const duplicate = value.match(/^([\p{L}'’-]+)([\p{Lu}].*\s\1)$/u);
  return (duplicate ? duplicate[2] : value).slice(0,80);
}

function scoreIconUrl(img, doc) {
  // Lazy images may still have a transparent placeholder in currentSrc/src.
  const nested = img.querySelector?.("img");
  if (nested) return scoreIconUrl(nested, doc);
  // Transfer the rendered bitmap where the page permits canvas access. This
  // also handles embedded image formats without re-fetching a provider URL.
  if (img.complete && img.naturalWidth > 1 && img.naturalHeight > 1) {
    try {
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      const scale = Math.min(1, 96 / Math.max(img.naturalWidth,img.naturalHeight));
      canvas.width = Math.max(1,Math.round(img.naturalWidth*scale)); canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
      const png = canvas.toDataURL("image/png"); if (png.length < 100000) return png;
    } catch (_e) {} // Cross-origin images retain their original HTTPS URL.
  }
  let background = "";
  try {background = doc.defaultView.getComputedStyle(img).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";} catch (_e) {}
  for (const source of [img.getAttribute("data-src"), img.getAttribute("data-iurl"), img.currentSrc, img.getAttribute("src"), background]) {
    if (!source) continue;
    if (/^data:image\/(?:png|webp|jpeg|gif);base64,[a-z0-9+/=]+$/i.test(source) && source.length < 100000) return source;
    try { const url = new URL(source, doc.baseURI); if (url.protocol === "https:") return url.href; } catch (_e) {}
  }
  return "";
}

function scoreTeamIcons(doc, root, away, home) {
  const normalize = (name) => String(name || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const matches = (label, team) => {
    const a = normalize(label), b = normalize(team);
    return a && b && (a === b || a.includes(b) || b.includes(a));
  };
  const find = (scope, team) => {
    for (const img of Array.from(scope.querySelectorAll("img")).slice(0, 100)) {
      const label = img.getAttribute("alt") || img.getAttribute("aria-label") || img.getAttribute("title") || "";
      if (matches(label, team) && !/highlights|recap|video|watch/i.test(label)) {
        const url = scoreIconUrl(img, doc); if (url) return url;
      }
    }
    // Empty-alt logos belong to a team column. Associate them with that
    // column's name instead of selecting the first two images (often videos).
    for (const label of Array.from(scope.querySelectorAll("span, div, a")).slice(0, 1600)) {
      if (!matches(textOf(label, 100), team) || label.children.length > 2) continue;
      let column = label;
      for (let depth = 0; column && column !== scope && depth < 4; depth++, column = column.parentElement) {
        const text = textOf(column, 300);
        const other = team === away ? home : away;
        if (matches(text, other)) break;
        for (const img of column.querySelectorAll("img")) {
          const width = img.naturalWidth || Number(img.getAttribute("width")) || 0;
          const height = img.naturalHeight || Number(img.getAttribute("height")) || 0;
          if (/recap|video|highlights/i.test(img.getAttribute("alt") || "") || (width && height && width / height > 1.8)) continue;
          const url = scoreIconUrl(img, doc); if (url) return url;
        }
      }
    }
    return "";
  };
  let scope = root || doc;
  let awayIcon = "", homeIcon = "";
  for (let depth = 0; scope && depth < 5; depth++, scope = scope.parentElement) {
    awayIcon ||= find(scope, away); homeIcon ||= find(scope, home);
    if (awayIcon && homeIcon) break;
  }
  // Current cards put the unlabelled bitmap in a sibling grid cell. Match its
  // rendered column to the clean team label, rather than requiring a wrapper.
  if (!awayIcon || !homeIcon) {
    const labels = {};
    let card = root;
    for (let depth = 0; card && depth < 4; depth++, card = card.parentElement) {
      for (const node of Array.from(card.querySelectorAll("span, div, a")).slice(0,1500)) {
        if (node.children.length > 1) continue;
        const name = scoreTeamName(node);
        for (const team of [away,home]) {
          if (normalize(name) !== normalize(team)) continue;
          const rect = node.getBoundingClientRect?.();
          if (rect?.width > 0 && rect.height > 0) labels[team] ||= rect;
        }
      }
      if (!labels[away] || !labels[home]) continue;
      const candidates = [];
      for (const image of card.querySelectorAll("img, [style*='background-image']")) {
        const rect = image.getBoundingClientRect?.();
        if (!rect || rect.width < 10 || rect.height < 10 || rect.width > 100 || rect.height > 100 || rect.width/rect.height > 1.8) continue;
        const url = scoreIconUrl(image,doc); if (!url) continue;
        const distance = team => {
          const label = labels[team];
          const dx = Math.abs(rect.x+rect.width/2-label.x-label.width/2);
          const dy = Math.abs(rect.y+rect.height/2-label.y-label.height/2);
          return dx < 90 && dy < 180 ? dx*3+dy : Infinity;
        };
        candidates.push({url,away:distance(away),home:distance(home)});
      }
      const first = candidates.filter(c=>c.away<c.home).sort((a,b)=>a.away-b.away)[0];
      const second = candidates.filter(c=>c.home<c.away).sort((a,b)=>a.home-b.home)[0];
      awayIcon ||= first?.url || ""; homeIcon ||= second?.url || "";
      if (awayIcon && homeIcon) break;
    }
  }
  // Google sometimes supplies empty alt text on the two explicitly labelled logo slots.
  if (root) {
    const first = root.querySelector(".imso_mh__first-logo img, img.imso_mh__first-logo, .imso_mh__first-tn img, .imso_mh__first-logo, .imso_mh__first-tn .imso_mh__logo img");
    const second = root.querySelector(".imso_mh__second-logo img, img.imso_mh__second-logo, .imso_mh__second-tn img, .imso_mh__second-logo, .imso_mh__second-tn .imso_mh__logo img");
    if (!awayIcon && first) awayIcon = scoreIconUrl(first, doc);
    if (!homeIcon && second) homeIcon = scoreIconUrl(second, doc);
  }
  return {awayIcon, homeIcon};
}

function scanScores(doc, url) {
  void url;
  // Preferred: Google sports match cards (class names change; keep as layer 1).
  const cardRoots = Array.from(
    doc.querySelectorAll(
      "div.imso_mh__mh-bd, div[data-tts='sports'], g-card-section, div.imso_mh__t"
    )
  );
  const results = [];
  const seen = new Set();
  let strategy = "cards";
  const pushResult = (home, away, hs, as, status, root) => {
    home = (home || "").slice(0, 60).trim();
    away = (away || "").slice(0, 60).trim();
    if (!home || !away) return;
    if (home.toLowerCase() === away.toLowerCase()) return;
    const id = "game:" + fnv1a(home.toLowerCase() + "|v|" + away.toLowerCase());
    if (seen.has(id)) return;
    seen.add(id);
    const scorePart = hs !== "" && as !== "" ? away + " " + as + " – " + hs + " " + home : away + " vs " + home;
    const icons = scoreTeamIcons(doc, root, away, home);
    results.push({
      id,
      summary: scorePart + (status ? " · " + status : ""),
      detail: (doc.title || "Google").slice(0, 120),
      url: doc.baseURI || "",
      fingerprint: fnv1a(home + "|" + away + "|" + hs + "|" + as + "|" + status + "|" + icons.awayIcon + "|" + icons.homeIcon),
      meta: { home, away, sport: /\bNFL\b|american football/i.test(pageText(doc,6000)) ? "football" : /\bNBA\b|basketball/i.test(pageText(doc,6000)) ? "basketball" : /\bMLB\b|baseball/i.test(pageText(doc,6000)) ? "baseball" : /\bNHL\b|hockey/i.test(pageText(doc,6000)) ? "hockey" : /soccer|premier league|\bFIFA\b/i.test(pageText(doc,6000)) ? "soccer" : "", homeScore: hs, awayScore: as, status: status || "", supported: true, ...icons },
    });
  };

  for (const root of cardRoots.slice(0, 8)) {
    const firstName = scoreTeamName(root.querySelector(".imso_mh__first-tn-ed") || root.querySelector(".imso_mh__first-tn"));
    const secondName = scoreTeamName(root.querySelector(".imso_mh__second-tn-ed") || root.querySelector(".imso_mh__second-tn"));
    const leftScore = textOf(root.querySelector(".imso_mh__l-tm-sc"), 8);
    const rightScore = textOf(root.querySelector(".imso_mh__r-tm-sc"), 8);
    if (firstName && secondName && /^\d{1,3}$/.test(leftScore) && /^\d{1,3}$/.test(rightScore)) {
      const status = textOf(root.querySelector(".imso_mh__stts, .imso_mh__ft-mtch"), 40) || findStatusToken(textOf(root, 500)) || "";
      pushResult(secondName, firstName, rightScore, leftScore, status, root);
      continue;
    }
    const nameEls = Array.from(root.querySelectorAll("div.imso_mh__first-tn-ed, div.imso_mh__second-tn-ed, span, div"))
      .map((e) => textOf(e, 40))
      .filter((t) => t && t.length >= 2 && t.length <= 32 && !/^\d/.test(t) && !/google|search|score|final|live|half|quarter/i.test(t));
    const scoreEls = Array.from(root.querySelectorAll("div.imso_mh__l-tm-sc, div.imso_mh__r-tm-sc, div.imso_mh__scr-sep, span")).map((e) => textOf(e, 8));
    const nums = scoreEls.filter((t) => /^\d{1,3}([:-]\d{1,3})?$/.test(t));
    const uniqNames = [...new Set(nameEls)].slice(0, 6);
    if (uniqNames.length >= 2 && nums.length >= 2) {
      const status = textOf(root.querySelector("div.imso_mh__stts, div.imso_mh__ft-mtch, span.imso_mh__stts"), 40) || "Live";
      pushResult(uniqNames[1], uniqNames[0], nums[1] || nums[0], nums[0], status, root);
    }
  }

  // Layer 2: quarter/total tables (e.g. NFL 1 2 3 4 T / Steelers 7 3 0 6 16).
  // Handles multi-column rows by taking the LAST number as the total.
  if (results.length === 0) {
    strategy = "table";
    try {
      const text = pageText(doc, 20000);
      const pageStatus = findStatusToken(text);
      const tables = Array.from(doc.querySelectorAll("table, [role=table]")).slice(0, 12);
      for (const tbl of tables) {
        const rows = Array.from(tbl.querySelectorAll("tr, [role=row]")).slice(0, 6);
        const parsed = [];
        for (const r of rows) {
          const cells = Array.from(r.querySelectorAll("th, td, [role=cell], [role=rowheader]")).map((c) => textOf(c, 48));
          if (cells.length < 2) continue;
          const nameCell = cells.find((c) => c && !/^\d{1,3}$/.test(c) && /^[A-Za-z .'\-&]{2,40}$/.test(c) && !/^(Team|Teams|Total|Score|1|2|3|4|T|OT|Q)$/i.test(c));
          const nums = cells.filter((c) => /^\d{1,3}$/.test(c));
          if (nameCell && nums.length >= 1) {
            parsed.push({ team: nameCell, score: nums[nums.length - 1], status: pageStatus });
          }
          if (parsed.length === 2) break;
        }
        if (parsed.length === 2) {
          pushResult(parsed[1].team, parsed[0].team, parsed[1].score, parsed[0].score, parsed[0].status || pageStatus || "Live", tbl);
        }
        if (results.length >= 6) break;
      }
    } catch (_e) {}
  }

  // Layer 3: title-driven scoreboard ("Steelers vs Browns" + 16 - 24 + Q4 clock).
  if (results.length === 0) {
    strategy = "title";
    try {
      const qInput = doc.querySelector("input[name='q']");
      const hay = (doc.title || "") + " " + ((qInput && qInput.value) || "");
      const mVs = hay.match(/([\p{L}.'&\- ]{2,40})\s+vs\.?\s+([\p{L}.'&\- ]{2,40})/iu);
      if (mVs) {
        const text = pageText(doc, 20000);
        const shortA = mVs[1].replace(/live score|score|nfl|football/gi, "").trim();
        const shortB = mVs[2].replace(/live score|score|nfl|football/gi, "").trim();
        if (shortA && shortB) {
          const fullA = expandTeamName(shortA, text);
          const fullB = expandTeamName(shortB, text);
          const status = findStatusToken(text) || "Live";
          // First dash-separated pair after both teams appear.
          const ia = text.toLowerCase().indexOf(shortA.split(/\s+/).pop().toLowerCase());
          const ib = text.toLowerCase().indexOf(shortB.split(/\s+/).pop().toLowerCase());
          const region = ia >= 0 && ib >= 0 ? text.slice(Math.min(ia, ib), Math.min(ia, ib) + 1200) : text.slice(0, 3000);
          const pm = region.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})/);
          if (pm) {
            // Order: which team is listed first in the region determines away/home.
            const firstIsA = ia <= ib;
            const away = firstIsA ? fullA : fullB;
            const home = firstIsA ? fullB : fullA;
            pushResult(home, away, pm[2], pm[1], status, null);
          } else {
            pushResult(fullB, fullA, "", "", status, null);
          }
        }
      }
    } catch (_e) {}
  }

  let sportsIntent = /score|vs\.?|football|nfl|nba|mlb|nhl|soccer|tennis|cricket|live/i.test(
    (doc.title || "") + " " + ((doc.querySelector("input[name='q']") || {}).value || "")
  );
  try {
    if (!sportsIntent) sportsIntent = /Q[1-4]\s*[-–]?\s*\d{1,2}:\d{2}|\bFinal\b|\bLIVE\b/i.test(pageText(doc, 4000));
  } catch (_e) {}
  const ready = results.length > 0 || !!doc.querySelector("div#search, div[role='main']");
  if (results.length === 0) {
    return {
      ready: !!ready,
      unsupported: sportsIntent ? true : false,
      items: [],
      meta: { cardRoots: cardRoots.length, tables: doc.querySelectorAll("table, [role=table]").length, reason: sportsIntent ? "unsupported-card-format" : "no-match-card", note: "Only two-sided team score cards are supported in this version; other formats are labelled unsupported." },
    };
  }
  return { ready: true, items: results.slice(0, MAX_ITEMS), meta: { matches: results.length, strategy, cardRoots: cardRoots.length, logos:results.map(item=>({away:!!item.meta.awayIcon,home:!!item.meta.homeIcon})) } };
}

// ---------------------------------------------------------------- actor

export class WorkspaceNotificationsChild extends JSWindowActorChild {
  constructor() {
    super();
    this._active = null; // { sourceId, service }
    this._observer = null;
    this._documentObserver = null;
    this._debounce = 0;
    this._lastSent = "";
    this._lastUrl = "";
    this._boundPop = null;
  }

  actorCreated() {
    try {
      this._init();
    } catch (_e) {}
  }

  didDestroy() {
    this._active = null;
    this._atomCache = null;
    this._githubCache = null;
    this.contentWindow?.clearInterval(this._mailPoll);
    try {
      if (this._observer) this._observer.disconnect();
      if (this._documentObserver) this._documentObserver.disconnect();
      this._documentObserver = null;
      this._observer = null;
    } catch (_e) {}
    if (this._debounce) {
      try {
        this.contentWindow.clearTimeout(this._debounce);
      } catch (_e) {}
      this._debounce = 0;
    }
  }

  _serviceForCurrentDoc() {
    try {
      const href = this.document?.location?.href || this.contentWindow?.location?.href || "";
      return { service: detectService(href), href };
    } catch (_e) {
      return { service: null, href: "" };
    }
  }

  _init() {
    const win = this.contentWindow;
    if (!win) return;
    const runWhenReady = () => {
      try {
        if (this.document?.readyState === "complete") this._afterLoad();
        else win.addEventListener("load", () => this._afterLoad(), { once: true });
      } catch (_e) {}
    };
    if (this.document?.readyState === "loading") {
      this.document.addEventListener("DOMContentLoaded", runWhenReady, { once: true });
    } else {
      runWhenReady();
    }
    if (!this._boundPop) {
      this._boundPop = () => this._onNavigation();
      try {
        win.addEventListener("popstate", this._boundPop);
        win.addEventListener("hashchange", this._boundPop);
      } catch (_e) {}
    }
  }

  _onNavigation() {
    // SPA navigation replaces the observed region: reset baseline signalling
    // by reattaching the observer and forcing a fresh snapshot pass.
    try {
      this._lastUrl = this.document?.location?.href || "";
    } catch (_e) {}
    this._reattachObserver();
    this._scheduleScan(120);
  }

  _afterLoad() {
    this._reattachObserver();
    // Only scan on load when chrome activated this tab; otherwise stay quiet.
    if (this._active) this._scheduleScan(150);
  }

  _reattachObserver() {
    try {
      if (this._observer) this._observer.disconnect();
      if (this._documentObserver) this._documentObserver.disconnect();
      this._documentObserver = null;
      this._observer = null;
    } catch (_e) {}
    const doc = this.document;
    if (!doc || !this._active) return;
    const target =
      doc.querySelector('div[role="main"]') ||
      doc.querySelector("div.Cp") ||
      doc.querySelector("main") ||
      doc.querySelector("div#search") ||
      doc.body;
    if (!target) return;
    try {
      const Obs = this.contentWindow.MutationObserver;
      this._observer = new Obs(() => this._scheduleScan(SCAN_DEBOUNCE_MS));
      this._observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "src", "srcset", "data-src", "data-iurl", "alt"],
        characterData: true,
      });
      // If the observed region is replaced, reattach.
      const docObs = new Obs(() => {
        try {
          if (!doc.contains(target)) {
            docObs.disconnect();
            this._reattachObserver();
          }
        } catch (_e) {}
      });
      this._documentObserver = docObs;
      docObs.observe(doc.documentElement || doc.body, { childList: true, subtree: true });
    } catch (_e) {}
  }

  _scheduleScan(delay) {
    const win = this.contentWindow;
    if (!win || !this._active) return;
    try {
      if (this._debounce) win.clearTimeout(this._debounce);
      this._debounce = win.setTimeout(() => {
        this._debounce = 0;
        this._scanAndSend("observer");
      }, typeof delay === "number" ? delay : SCAN_DEBOUNCE_MS);
    } catch (_e) {}
  }

  _diagnostic(stage, details = {}, level = "debug") {
    if (!this._active) return;
    try {
      this.sendAsyncMessage("WorkspaceNotifications:Diagnostic", { ...this._active, stage, details, level });
    } catch (error) { console.error("[WorkspaceNotifications] diagnostic delivery failed", error); }
  }

  async _gmailSnapshot(doc, href, reason) {
    const account = new URL(href).pathname.match(/\/mail\/u\/(\d+)\//);
    if (!account) return {...scanGmail(doc), meta:{mode:"dom", atomReason:"Account path unavailable"}};
    const feedUrl = new URL("/mail/u/" + account[1] + "/feed/atom", href).href;
    const dom = scanGmail(doc);
    const readState = JSON.stringify(dom.meta.readIds || []);
    const readChanged = this._gmailReadState !== readState;
    this._gmailReadState = readState;
    if (this._atomCache?.url === feedUrl && Date.now() - this._atomCache.ts < 60000 && reason !== "manual" && !readChanged) {
      if (this._atomCache.out.meta.mode === "atom") return this._atomCache.out;
      const fresh = scanGmail(doc);
      fresh.meta = {...fresh.meta, mode:"dom", atomReason:this._atomCache.out.meta.atomReason};
      return fresh;
    }
    const controller = new this.contentWindow.AbortController();
    const timeout = this.contentWindow.setTimeout(() => controller.abort(), 8000);
    let out;
    try {
      const response = await this.contentWindow.fetch(feedUrl, {credentials:"include", cache:"no-store", redirect:"error", signal:controller.signal});
      if (!response.ok) throw new Error("HTTP " + response.status);
      const xml = await response.text();
      if (xml.length > 500000) throw new Error("Feed too large");
      out = parseGmailAtom(xml, doc, feedUrl);
      this._diagnostic("Gmail Atom available", {items:out.items.length}, "info");
    } catch (error) {
      out = scanGmail(doc); out.meta = {...out.meta, mode:"dom", atomReason:String(error.message || error).slice(0,120)};
      this._diagnostic("Gmail DOM fallback", {reason:out.meta.atomReason}, "info");
    } finally {this.contentWindow?.clearTimeout(timeout);}
    this._atomCache = {url:feedUrl, ts:Date.now(), out};
    return out;
  }

  async _githubSnapshot(doc, href, reason) {
    if(new URL(href).hostname !== 'github.com')return {ready:false,unsupported:true,items:[]};
    const inbox='https://github.com/notifications?query=is%3Aunread';
    if(new URL(href).pathname.startsWith('/notifications')) {
      const dom=scanGitHub(doc,href);if(dom.ready && /is:unread/i.test(new URL(href).searchParams.get('query') || ''))return dom;
    }
    if(this._githubCache && reason !== 'manual' && Date.now()-this._githubCache.ts<60000)return this._githubCache.out;
    const controller=new this.contentWindow.AbortController(),timeout=this.contentWindow.setTimeout(()=>controller.abort(),8000);
    try {
      const response=await this.contentWindow.fetch(inbox,{credentials:'include',cache:'no-store',signal:controller.signal});
      if(new URL(response.url || inbox).pathname.startsWith('/login'))return {ready:false,signin:true,items:[],meta:{mode:'inbox'}};
      if(!response.ok)throw Error('GitHub HTTP '+response.status);
      const html=await response.text();if(html.length>5000000)throw Error('Inbox response too large');
      const parsed=new this.contentWindow.DOMParser().parseFromString(html,'text/html');
      const out=scanGitHub(parsed,inbox);
      if(!out.ready && !out.signin)throw Error('Open GitHub Notifications / Unread to finish loading the inbox');
      this._githubCache={ts:Date.now(),out};return out;
    } catch(e) {
      this._diagnostic('GitHub inbox unavailable',{error:e.message},'info');
      return {ready:false,items:[],meta:{mode:'inbox',reason:e.message}};
    } finally {this.contentWindow?.clearTimeout(timeout);}
  }

  async _scanAndSend(reason) {
    if (!this._active) return;
    const active = this._active;
    const doc = this.document;
    if (!doc) { this._diagnostic("document unavailable", {}, "error"); return; }
    const href = doc.location?.href || "";
    this._diagnostic("scan started", {reason, readyState: doc.readyState});
    const wanted = this._active.service;
    const detected = detectService(href);
    const scanTime = Date.now();
    let listKey = canonicalListKey(wanted, href);
    const navigated = this._lastUrl && this._lastUrl !== href;
    if (navigated) this._lastSent = "";
    this._lastUrl = href;

    let out = { ready: false, items: [], meta: {} };
    try {
      if (detected === "github-unsupported" && wanted === "github") {
        out = { ready: true, unsupported: true, items: [], meta: { reason: "unsupported-github-page" } };
      } else if (!detected || (wanted !== detected && !(wanted === "scores" && detected === "scores"))) {
        out = { ready: true, unsupported: true, items: [], meta: { reason: "unsupported-page", detected: detected || "none" } };
      } else if (wanted === "gmail") {
        if (this._gmailBusy) { this._gmailRescan = true; return; }
        this._gmailBusy = true;
        try { out = await this._gmailSnapshot(doc, href, reason); } finally { this._gmailBusy = false; }
        listKey = "gmail:u/" + (href.match(/\/mail\/u\/(\d+)/) || [,"0"])[1] + ":" + (out.meta.mode === "atom" ? "atom-inbox" : canonicalListKey(wanted, href));
      }
      else if (wanted === "github") {
        if(this._githubBusy)return;
        this._githubBusy=true;try {out=await this._githubSnapshot(doc,href,reason);}finally {this._githubBusy=false;}
      }
      else if (wanted === "calendar") return; // Native browser reminders are collected in the parent process.
      else if (wanted === "scores") out = scanScores(doc, href);
    } catch (e) {
      this._diagnostic("scan failed", {error: String(e)}, "error");
      out = { ready: false, items: [], meta: { error: String((e && e.message) || e).slice(0, 200) } };
    }

    if (this._active !== active || this.document !== doc || doc.location?.href !== href) return;
    if (this._gmailRescan) {this._gmailRescan = false; this._scheduleScan(100);}
    const snapshot = {
      v: 1,
      sourceId: this._active.sourceId,
      service: wanted,
      href: href.slice(0, 500),
      listKey,
      ready: !!out.ready,
      unsupported: !!out.unsupported,
      signin: !!out.signin,
      navigated: !!navigated,
      items: Array.isArray(out.items) ? out.items.slice(0, MAX_ITEMS) : [],
      scanTime,
      reason,
      meta: out.meta || {},
    };
    // Deduplicate identical snapshots in the child before sending.
    try {
      const sig = fnv1a(JSON.stringify([snapshot.listKey, snapshot.ready, snapshot.items.map((i) => i.id + "=" + i.fingerprint)]));
      if (sig === this._lastSent && reason === "observer") return;
      this._lastSent = sig;
    } catch (_e) {}
    try {
      this.sendAsyncMessage("WorkspaceNotifications:Snapshot", snapshot);
    } catch (error) { this._diagnostic("snapshot delivery failed", {error: String(error)}, "error"); }
  }

  _openItem(data) {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win) return;
    const url = typeof data?.url === "string" ? data.url.slice(0, 600) : "";
    const itemId = typeof data?.itemId === "string" ? data.itemId : "";
    try {
      if (itemId && this._active?.service === "gmail") {
        const rows = Array.from(doc.querySelectorAll("tr.zA, tr[role='row'], div[role='row']"));
        for (const row of rows) {
          if ("gmail:" + gmailThreadId(row, doc) === itemId) {
            const link = row.querySelector("a[href]") || row;
            if (link && link.click) link.click();
            return;
          }
        }
        if (!url && typeof data.summary === "string" && data.summary) {
          win.location.hash = "search/" + encodeURIComponent(data.summary.split("\u2014").pop().trim());
          return;
        }
      }
      if (itemId && this._active?.service === "github") {
        const idUrl = itemId.startsWith("github:") ? itemId.slice(7) : "";
        if (isHttpsHttpUrl(idUrl) && idUrl.includes("github.com")) {
          win.location.href = idUrl;
          return;
        }
      }
    } catch (_e) {}
    if (isHttpsHttpUrl(url)) {
      try {
        win.location.href = url;
      } catch (_e) {}
    }
  }

  async receiveMessage(msg) {
    try {
      if (msg.name === "WorkspaceNotifications:Activate") {
        const d = msg.data || {};
        const service = typeof d.service === "string" ? d.service : "";
        const sourceId = typeof d.sourceId === "string" ? d.sourceId : "";
        if (!["gmail", "github", "scores"].includes(service) || !sourceId) return;
        if (this._active?.service === service && this._active?.sourceId === sourceId && this._observer) return;
        this.contentWindow?.clearInterval(this._mailPoll);
        this._atomCache = null;
    this._githubCache = null;
        this._active = { service, sourceId };
        if (service === "gmail" || service === "github") this._mailPoll = this.contentWindow.setInterval(() => this._scanAndSend("poll"), 60000);
        this._diagnostic("activated", {readyState: this.document?.readyState});
        this._lastSent = "";
        this._reattachObserver();
        this._scanAndSend("activate");
        return;
      }
      if (msg.name === "WorkspaceNotifications:Deactivate") {
        this._active = null;
        this._atomCache = null;
    this._githubCache = null;
        this.contentWindow?.clearInterval(this._mailPoll);
        try {
          if (this._observer) this._observer.disconnect();
          if (this._documentObserver) this._documentObserver.disconnect();
          this._documentObserver = null;
          this._observer = null;
        } catch (_e) {}
        return;
      }
      if (msg.name === "WorkspaceNotifications:ScanNow") {
        if (!this._active) return;
        const d = msg.data || {};
        if (d.sourceId && d.sourceId !== this._active.sourceId) return;
        this._scanAndSend("manual");
        return;
      }
      if (msg.name === "WorkspaceNotifications:OpenItem") {
        this._openItem(msg.data || {});
      }
    } catch (error) { this._diagnostic("message failed", {message: msg.name, error: String(error)}, "error"); }
  }
}

// Exported for static fixture validation (no effect in Firefox content).
export const __wnTest = {
  gmailMessageTime,
  scoreTeamName,
  parseGmailAtom,
  detectService,
  canonicalListKey,
  scanGmail,
  scanGitHub,
  scanScores,
  scoreTeamIcons,
  cleanGitHubTitle,
  githubRepoFromHref,
  githubNumberFromHref,
};
