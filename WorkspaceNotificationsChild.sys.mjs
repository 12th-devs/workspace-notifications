import {mailDate} from './NotificationData.sys.mjs';
import {gmailFeedURL,parseGmailAtom} from './NotificationGmail.sys.mjs';
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
    meta: { rows: rows.length, unread: items.length, completeInbox:rows.length===0, readIds:rows.filter(row=>row.classList.contains("yO") || row.getAttribute("data-is-read") === "true").map(row=>"gmail:"+gmailThreadId(row,doc)) },
  };
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
  return {ready:rows.length>0 || empty,items:items.sort((a,b)=>b.ts-a.ts || a.meta.sourceRank-b.meta.sourceRank).slice(0,MAX_ITEMS),meta:{mode:"inbox",rows:rows.length,unread:items.length,completeInbox:items.length<=MAX_ITEMS && !doc.querySelector('[rel="next"], .paginate-container .next_page:not(.disabled), [aria-label="Next page"]:not([disabled])')}};
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

  // Background Atom fetch must never trigger Gmail's HTTP Basic auth dialog
  // (signed-out Atom returns 401 with WWW-Authenticate: Basic, and a content
  // fetch would pop the modal in the screenshot). XHR with
  // mozBackgroundRequest suppresses the prompt while still sending the
  // tab's cookies/container. Falls back to fetch where XHR is unavailable
  // (tests).
  _fetchAtomText(feedUrl, signal) {
    const win = this.contentWindow;
    if (win.XMLHttpRequest) {
      return new Promise((resolve, reject) => {
        let xhr;
        try {
          xhr = new win.XMLHttpRequest();
        } catch (e) { reject(e); return; }
        try { xhr.mozBackgroundRequest = true; } catch (_e) {}
        try { xhr.open("GET", feedUrl, true); } catch (e) { reject(e); return; }
        try { xhr.withCredentials = true; } catch (_e) {}
        try { xhr.setRequestHeader("Cache-Control", "no-cache"); } catch (_e) {}
        try { xhr.setRequestHeader("Accept", "application/atom+xml, application/xml, text/xml, */*"); } catch (_e) {}
        if (signal) {
          if (signal.aborted) { reject(new Error("Aborted")); return; }
          try { signal.addEventListener("abort", () => { try { xhr.abort(); } catch (_e) {} }, { once: true }); } catch (_e) {}
        }
        xhr.onload = () => {
          try { resolve({ status: xhr.status, finalUrl: xhr.responseURL || feedUrl, text: xhr.responseText ?? "" }); }
          catch (e) { reject(e); }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.onabort = () => reject(new Error("Aborted"));
        xhr.ontimeout = () => reject(new Error("Timeout"));
        try { xhr.timeout = 8000; } catch (_e) {}
        try { xhr.send(); } catch (e) { reject(e); }
      });
    }
    return win.fetch(feedUrl, { credentials: "include", cache: "no-store", redirect: "error", signal }).then(async (response) => {
      let text = "";
      try { text = await response.text(); } catch (_e) { text = ""; }
      return {
        status: response.status,
        ok: response.ok,
        finalUrl: response.url || feedUrl,
        text,
      };
    });
  }

  async _gmailSnapshot(doc, href, reason) {
    const feedUrl = gmailFeedURL(href);
    const dom = scanGmail(doc);
    const readState = JSON.stringify(dom.meta.readIds || []);
    const readChanged = this._gmailReadState !== readState;
    this._gmailReadState = readState;
    if (this._atomCache?.url === feedUrl && Date.now() - this._atomCache.ts < 60000 && reason !== "manual" && !readChanged) {
      return this._atomCache.out;
    }
    const controller = new this.contentWindow.AbortController();
    const timeout = this.contentWindow.setTimeout(() => controller.abort(), 8000);
    let out;
    try {
      const { status, finalUrl, text: xml } = await this._fetchAtomText(feedUrl, controller.signal);
      if (status === 401 || status === 403) {
        const error = new Error("HTTP " + status); error.signin = true; throw error;
      }
      if (/accounts\.google\.com|ServiceLogin/i.test(finalUrl || "") || /accounts\.google\.com|ServiceLogin/i.test(xml.slice(0, 2000))) {
        const error = new Error("Gmail login required"); error.signin = true; throw error;
      }
      if (status < 200 || status >= 300) {
        throw new Error("HTTP " + status);
      }
      if (finalUrl && finalUrl !== feedUrl && !finalUrl.startsWith("https://mail.google.com/mail/")) throw Error('Gmail feed URL changed');
      if (xml.length > 500000) throw new Error("Feed too large");
      out = await this.sendQuery('WorkspaceNotifications:ParseGmailAtom',{sourceId:this._active.sourceId,service:'gmail',href,xml});
      if(!out?.ready)throw Error(out?.error || 'Gmail feed parser unavailable');
      this._diagnostic("Gmail Atom available", {items:out.items.length}, "info");
    } catch (error) {
      const message=String(error.message || error).slice(0,120);
      this._diagnostic('Gmail Atom unavailable',{reason:message},'info');
      return {ready:false,signin:!!error.signin,items:[],meta:{mode:'atom',reason:'Gmail Atom unavailable: '+message}};
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
      } else if (!detected || (wanted !== detected)) {
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
    } catch (e) {
      this._diagnostic("scan failed", {error: String(e)}, "error");
      out = { ready: false, items: [], meta: { error: String((e && e.message) || e).slice(0, 200) } };
    }

    if (this._active !== active || this.document !== doc || doc.location?.href !== href) return;
    if (this._gmailRescan) {this._gmailRescan = false; this._scheduleScan(100);}
    if(out.ready && !out.unsupported && !out.signin){
      const login=wanted==='github'?doc.querySelector('meta[name="user-login"]')?.getAttribute('content'):'';
      const email=wanted==='gmail'?(doc.title || '').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0]:'';
      const accountLabel=login && /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(login)?'@'+login:email || '';
      if(accountLabel)out.meta={...out.meta,accountLabel};
    }
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
        if (!["gmail", "github"].includes(service) || !sourceId) return;
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
  parseGmailAtom,
  gmailFeedURL,
  detectService,
  canonicalListKey,
  scanGmail,
  scanGitHub,
  cleanGitHubTitle,
  githubRepoFromHref,
  githubNumberFromHref,
};
