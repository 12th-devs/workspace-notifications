// ==UserScript==
// @name           Workspace Notifications
// @description    Shared notifications and live scores before the native workspace menu.
// @version        1.10.0
// @author         Workspace Notifications
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function () {
  "use strict";

  if (window.WorkspaceNotificationsBooted) return;
  window.WorkspaceNotificationsBooted = true;

  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const ACTOR = "WorkspaceNotifications";
  const OBS_TOPIC = "workspace-notifications-changed";
  const STORE_FILE = "workspace-notifications.json";
  const TAB_VALUE_KEY = "wn-source-id";
  const MAX_NOTIFICATIONS = 100;
  const NOTIF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const MIN_REFRESH_MS = 2 * 60 * 1000;

  const SERVICE_LABEL = { gmail: "Mail", github: "GitHub", calendar: "Calendar", scores: "Scores", slack: "Slack", teams: "Microsoft Teams", discord: "Discord", outlook: "Outlook" };
  const NATIVE_SERVICES = new Set(["calendar", "slack", "teams", "discord", "outlook"]);
  let NativeApps={}, nativeServiceForURL=()=>null;

  // Native Zen icons (verified in omni.ja) rendered as currentColor masks, so
  // no text or emoji glyph is ever used as an icon.
  const WN_ICON_ROOT = "chrome://browser/skin/zen-icons/";
  const WN_ICONS = {
    inbox: "selectable/inbox.svg",
    apps: "selectable/grid-2x2.svg",
    teams: "selectable/people.svg",
    settings: "settings.svg",
    plus: "plus.svg",
    close: "close.svg",
    chev: "arrow-right.svg",
    back: "back.svg",
    open: "share.svg",
    check: "selectable/checkbox.svg",
    minus: "unpin.svg",
  };
  function wnIcon(name) {
    const s = document.createElement("span");
    s.className = "wn-ico wn-ico-" + name;
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  function getPref(name, def) {
    try {
      const p = "workspace-notifications." + name;
      if (typeof def === "boolean") return Services.prefs.getBoolPref(p, def);
      if (typeof def === "number") {
        try { return Services.prefs.getIntPref(p, def); }
        catch (_e) {
          const s = Services.prefs.getStringPref(p, "");
          const n = parseInt(s, 10);
          return Number.isFinite(n) ? n : def;
        }
      }
      return Services.prefs.getStringPref(p, def);
    } catch (_e) { return def; }
  }
  function isDebug() {
    try {
      if (Services.prefs.getBoolPref("workspace-notifications.debug", false)) return true;
      // Legacy/alternate spelling some users try first.
      if (Services.prefs.getBoolPref("workspace.notifications.debug", false)) return true;
    } catch (_e) {}
    return false;
  }
  const diagnosticEvents = [];
  const logThrottle = new Map();
  function logEvent(stage, details = {}, level = "debug") {
    const message = stage + " " + JSON.stringify(details);
    const now = Date.now();
    if (now - (logThrottle.get(message) || 0) < 3000) return;
    logThrottle.set(message, now);
    if (logThrottle.size > 200) logThrottle.delete(logThrottle.keys().next().value);
    diagnosticEvents.push(new Date(now).toLocaleTimeString() + " " + message);
    if (diagnosticEvents.length > 50) diagnosticEvents.shift();
    if (isDebug() || level !== "debug") (level === "error" ? console.error : console.log)("[WorkspaceNotifications] " + message);
  }
  function dlog(...args) { logEvent(String(args[0]), {detail: args.slice(1).map(String).join(" ")}); }
  function isEnabled() {
    try { return Services.prefs.getBoolPref("workspace-notifications.enabled", true); } catch (_e) { return true; }
  }
  function isPrivateWindow(win) {
    try { return win.PrivateBrowsingUtils && win.PrivateBrowsingUtils.isWindowPrivate(win); } catch (_e) { return false; }
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function validHttpsUrl(u) {
    if (typeof u !== "string" || !u) return "";
    try {
      const url = new URL(u);
      if (url.protocol !== "https:") return "";
      return url.href.slice(0, 600);
    } catch (_e) { return ""; }
  }
  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      if (!Number.isFinite(+d)) return "";
      const now = new Date();
      const opts = { hour: "numeric", minute: "2-digit" };
      if (d.toDateString() !== now.toDateString()) { opts.month = "short"; opts.day = "numeric"; }
      if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
      return d.toLocaleString(undefined, opts);
    } catch (_e) { return ""; }
  }

  // ------------------------------------------------ store

  const store = {
    followedTeams: {},
    connections: [],   // {id, service, url, label, containerId, paused, bgRefresh, listKey, baseline:Set->Array, baselineFp:{}, lastScanTs, lastOkTs, status, reminded:{}, gameIds:[], showInTitle}
    notifications: [], // {id, service, sourceId, account, summary, detail, url, ts, seen, kind, game?}
    dismissIds: {},     // id -> ts
    unpinnedIds: {},    // id -> ts (hidden from the workspace indicator, kept in the feed)
    followedGames: {},  // matchKey -> {id, sourceId, home, away, homeScore, awayScore, status, lastUpdate, dismissed, showInTitle, finalShownTs}
    titleGameKey: "",
    seq: 0,
  };

  let notificationTime=n=>n.ts ? new Date(n.ts).toLocaleString() : "";
  let Sources=null, detachSources=null, compareNotifications=(a,b)=>(b.ts||0)-(a.ts||0);
  let sourceView="inbox", sourceDetailId="", pickerLeague="nfl", pickerQuery="", pickerTeams=[], pickerStatus="", pickerGeneration=0, icalUrl="", icalError="";

  function followTeam(team) {
    if (!team || !["nfl","nba","mlb","nhl"].includes(team.league) || !/^\d+$/.test(String(team.id))) throw Error("Choose a supported team");
    const key="espn:"+team.league+":"+team.id;
    store.followedTeams[key]={...team,id:String(team.id),provider:"espn",paused:false,status:"Loading games\u2026",schedule:store.followedTeams[key]?.schedule || []};
    Sources?.refresh(team.league,team.id); broadcast(window); renderAll(); return key;
  }
  function unfollowTeam(key) {
    delete store.followedTeams[key];
    for (const [id,g] of Object.entries(store.followedGames)) if (g.provider === "espn" && !gameActive(g)) {
      delete store.followedGames[id]; if (store.titleGameKey===id) store.titleGameKey="";
    }
    broadcast(window); renderAll();
  }
  function handleSourceEvent(event) {
    let changed=false;
    if (event.type === "error") {logEvent("source error",{error:event.message},"error"); return;}
    if (event.type === "schedule" || event.type === "providerStatus") {
      const t=store.followedTeams[event.key];
      if (t) {
        if (t.paused) return;
        if (event.games) {t.schedule=event.games; t.scheduleError=""; changed=true;}
        if(event.stage === "schedule") t.scheduleError=event.status;
        if(event.status === "Monitoring" && t.scheduleError)event.status=t.scheduleError;
        if (t.status !== event.status) {t.status=event.status; changed=true;}
      } else {
        // Coordinator-polled connections (iCal feeds) report status by conn id.
        const cc=connForSourceId(event.key);
        if (!cc || cc.paused) return;
        if (cc.status !== event.status) {cc.status=event.status; changed=true;}
      }
    } else if (event.type === "game") {
      const g=event.game; if (!gameActive(g)) return;
      const prev=store.followedGames[g.id];
      store.followedGames[g.id]={...prev,...g,sourceId:g.id,lastUpdate:Date.now(),dismissed:prev?.dismissed || false};
      for (const t of Object.values(store.followedTeams)) if (t.league===g.league && g.teamIds.includes(t.id)) {
        t.schedule=(t.schedule || []).filter(x=>x.id!==g.id).concat(g).sort((a,b)=>a.startTs-b.startTs);
      }
      if ((g.state==='in' && !prev?.startAlerted) || (g.completed && !prev?.finalAlerted)) {
        const kind=g.completed ? 'final' : 'start';
        store.followedGames[g.id][g.completed ? 'finalAlerted' : 'startAlerted']=true;
        const n={id:g.id+":"+kind,service:"scores",sourceId:g.id,summary:scoreText(g),detail:g.status,url:g.url,ts:Date.now(),seen:!prev && g.completed,kind:"game",game:{...scoreSnapshot(g),key:g.id,final:g.completed}};
        if (!prev && g.completed) pushQuiet(n); else pushNotification(n);
      }
      changed=true;
    } else if (event.type === "calendar" || event.type === "native") {
      const c=connForSourceId(event.sourceId); if (!c || (c.paused && !event.closed)) return;
      if (!event.closed) c.lastAlertAt=Date.now();
      const n=store.notifications.find(n=>n.nativeKey===event.key);
      if (event.closed) {if (n && n.nativeInstance===event.instance && n.nativeActive) {n.nativeActive=false;changed=true;}}
      else {
        const id=event.key+":"+event.instance;
        if ((n?.nativeInstance===event.instance && n.summary===event.summary && n.detail===(event.detail || "")) || store.dismissIds[id]) return;
        if (n) store.notifications=store.notifications.filter(x=>x!==n);
        pushNotification({id,service:c.service,sourceId:c.id,account:c.ical ? "iCal feed" : SERVICE_LABEL[c.service],summary:event.summary || (c.service==="calendar"?"Calendar reminder":"Notification"),detail:event.detail || "",url:c.ical ? "" : c.url,ts:event.ts,seen:false,kind:"alert",nativeKey:event.key,nativeInstance:event.instance,nativeActive:c.service==="calendar",icon:teamIconUrl(event.icon)});
        changed=true;
      }
    }
    if (changed) {broadcast(window);renderAll();}
  }

  function nativeIconUrl(value) {
    if(typeof value !== "string" || value.length>100000)return "";
    if(/^(?:https?:\/\/|page-icon:|moz-anno:favicon:|chrome:\/\/|resource:\/\/|data:image\/)/i.test(value))return value;
    return "";
  }
  // Tabler Icons (MIT, see zia-extended-icons/icons/tabler-LICENSE): inline
  // outline glyph with a currentColor stroke. Used where no native tab
  // favicon can exist — iCal feeds have no tab.
  function tablerCalendarClock() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("wn-app-icon");
    svg.dataset.wnSrc = "tabler:calendar-clock";
    for (const d of ["M10.5 21h-4.5a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v3", "M16 3v4", "M8 3v4", "M4 11h10", "M14 18a4 4 0 1 0 8 0a4 4 0 1 0 -8 0", "M18 16.5v1.5l.5 .5"]) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }
  function appIcon(source) {
    const conn=connForSourceId(source.sourceId || source.id), found=conn ? findTabBySourceId(conn.id) : null;
    if (conn?.ical) return tablerCalendarClock();
    const tab=found?.tab;
    const native=tab?.getAttribute('image') || tab?.linkedBrowser?.mIconURL || tab?.querySelector('.tab-icon-image')?.getAttribute('src') || conn?.icon;
    if(conn && nativeIconUrl(native))conn.icon=nativeIconUrl(native);
    const icon=document.createElement('img');icon.className='wn-app-icon';icon.alt='';
    icon.src=nativeIconUrl(native) || (validHttpsUrl(conn?.url || source.url) ? 'page-icon:'+(conn?.url || source.url) : '');
    icon.dataset.wnSrc=icon.src;
    icon.onerror=()=>{icon.hidden=true;};
    return icon;
  }
  function ingestGitHub(conn,items,isFirst) {
    const previous=store.notifications.filter(n=>n.service==='github' && n.sourceId===conn.id),byItem=new Map(previous.map(n=>[n.itemId,n]));
    conn.openedGithub ||= {};
    const reported=new Set(items.map(i=>i.id));
    for(const id of Object.keys(conn.openedGithub))if(!reported.has(id))delete conn.openedGithub[id];
    const next=[];
    for(const item of items) {
      if(!item.id?.startsWith('github:thread:') || item.meta?.unread !== true)continue;
      const fp=String(item.fingerprint || ''),base='n-'+conn.id+'-'+item.id,id=base+'-r'+fp.slice(0,8),old=byItem.get(item.id);
      if(conn.openedGithub[item.id]===fp || store.dismissIds[id] || store.dismissIds[base])continue;
      const n={id,itemId:item.id,service:'github',sourceId:conn.id,account:'GitHub',summary:item.summary,detail:item.detail,url:validHttpsUrl(item.url),
        ts:item.ts || old?.ts || Date.now(),githubTimeKnown:!!item.ts,githubVerified:true,sourceRank:item.meta.sourceRank || 0,seen:old?.seen ?? isFirst,kind:'alert'};
      next.push(n);
      if(!isFirst && (!conn.baseline.has(item.id) || conn.baselineFp[item.id]!==fp))onNewBrief(n);
    }
    store.notifications=store.notifications.filter(n=>!(n.service==='github' && n.sourceId===conn.id)).concat(next);
    conn.baseline=reported;conn.baselineFp=Object.fromEntries(items.map(i=>[i.id,String(i.fingerprint || '')]));
    return {changed:JSON.stringify(previous)!==JSON.stringify(next)};
  }

  function storeFilePath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    return PathUtils.join(f.path, STORE_FILE);
  }

  function serialize() {
    prune();
    return {
      v: 2,
      seq: store.seq,
      followedTeams:store.followedTeams,
      connections: store.connections.map((c) => ({
        id: c.id, service: c.service, url: c.url, label: c.label, containerId: c.containerId || 0,
        paused: !!c.paused, bgRefresh: !!c.bgRefresh, listKey: c.listKey || "", ical: !!c.ical,
        baseline: Array.from(c.baseline || []), baselineFp: c.baselineFp || {}, baselineReady: !!c.baselineReady,
        lastScanTs: c.lastScanTs || 0, lastOkTs: c.lastOkTs || 0, lastAlertAt:c.lastAlertAt || 0, status: c.status || "",
        reminded: c.reminded || {}, openedMail: c.openedMail || {}, openedGithub:c.openedGithub || {}, icon:nativeIconUrl(c.icon),
        hasScanned: !!c.hasScanned, actorOk: c.actorOk !== false,
        lastMeta: typeof c.lastMeta === "string" ? c.lastMeta.slice(0, 220) : "",
        lastCount: c.lastCount | 0,
      })),
      notifications: store.notifications.slice(0, MAX_NOTIFICATIONS).map((n) => ({
        id: n.id, service: n.service, sourceId: n.sourceId, account: n.account,
        summary: n.summary, detail: n.detail, url: n.url, ts: n.ts, seen: !!n.seen, kind: n.kind || "alert",
        game: n.game || null, itemId:n.itemId || "", mailDate:n.mailDate || "", mailTimeKnown:!!n.mailTimeKnown, mailVerified:!!n.mailVerified, githubVerified:!!n.githubVerified, githubTimeKnown:!!n.githubTimeKnown, mailPrecision:n.mailPrecision || "time", sourceRank:n.sourceRank || 0, observedTs:n.observedTs || 0, nativeKey:n.nativeKey || "", nativeInstance:n.nativeInstance || "", nativeActive:!!n.nativeActive, icon:n.icon || "",
      })),
      dismissIds: store.dismissIds,
      unpinnedIds: store.unpinnedIds,
      followedGames: store.followedGames,
      titleGameKey: store.titleGameKey,
    };
  }

  let saveTimer = 0;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      try {
        IOUtils.writeUTF8(storeFilePath(), JSON.stringify(serialize())).catch(() => {});
      } catch (_e) {}
    }, 400);
  }

  function prune(now) {
    now = now || Date.now();
    // Remove only the known toolbar controls emitted by the old Calendar adapter.
    store.notifications = store.notifications.filter((n) => !(n.service === "calendar" && /^(close|go back|main menu)$/i.test(n.summary.trim()) && (!n.detail || n.detail.trim() === n.summary.trim())));
    store.notifications = store.notifications.filter((n) => (n.service === "gmail" || n.nativeActive || now - n.ts < NOTIF_TTL_MS)).sort(compareNotifications).slice(0, MAX_NOTIFICATIONS);
    for (const k of Object.keys(store.dismissIds)) {
      if (now - store.dismissIds[k] > DISMISS_TTL_MS) delete store.dismissIds[k];
    }
    for (const k of Object.keys(store.unpinnedIds)) {
      if (now - store.unpinnedIds[k] > DISMISS_TTL_MS) delete store.unpinnedIds[k];
    }
    store.notifications = store.notifications.filter((n) => !store.dismissIds[n.id]);
  }

  function loadStore() {
    try {
      IOUtils.readUTF8(storeFilePath()).then((json) => {
        try {
          const d = JSON.parse(json);
          if (Array.isArray(d.connections)) {
            store.connections = d.connections.map((c) => ({
              id: String(c.id || ("src-" + Math.random().toString(36).slice(2))),
              service: Object.hasOwn(SERVICE_LABEL,c.service) ? c.service : "gmail",
              url: typeof c.url === "string" ? c.url.slice(0, 600) : "",
              label: typeof c.label === "string" ? c.label.slice(0, 160) : "",
              containerId: c.containerId | 0, ical: !!c.ical,
              paused: !!c.paused, bgRefresh: !!c.bgRefresh, listKey: c.listKey || "",
              baseline: new Set(Array.isArray(c.baseline) ? c.baseline : []),
              baselineReady: c.baselineReady ?? (Array.isArray(c.baseline) && c.baseline.length > 0),
              baselineFp: c.baselineFp && typeof c.baselineFp === "object" ? c.baselineFp : {},
              lastScanTs: Number(c.lastScanTs) || 0, lastOkTs: Number(c.lastOkTs) || 0, lastAlertAt:Number(c.lastAlertAt) || 0, status: c.status || "",
              reminded: c.reminded && typeof c.reminded === "object" ? c.reminded : {}, openedMail: c.openedMail || {}, openedGithub:c.openedGithub || {}, icon:nativeIconUrl(c.icon),
              hasScanned: !!c.hasScanned, actorOk: c.actorOk !== false,
              lastMeta: typeof c.lastMeta === "string" ? c.lastMeta.slice(0, 220) : "",
              lastCount: c.lastCount | 0,
            }));
          }
          if (Array.isArray(d.notifications)) {
            store.notifications = d.notifications.filter((n) => n && n.id && n.summary).map((n) => ({
              id: String(n.id), service: n.service, sourceId: n.sourceId || "",
              account: String(n.account || "").slice(0, 160),
              summary: String(n.summary || "").slice(0, 240),
              detail: String(n.detail || "").slice(0, 300),
              url: validHttpsUrl(n.url),
              ts: +n.ts || (n.service === "gmail" ? 0 : Date.now()), seen: !!n.seen, kind: n.kind || "alert",
              game: n.game && typeof n.game === "object" ? n.game : null, itemId:n.itemId || "", mailDate:n.mailDate || "", mailTimeKnown:!!n.mailTimeKnown, mailVerified:false, githubVerified:false, githubTimeKnown:!!n.githubTimeKnown, mailPrecision:n.mailPrecision || "time", sourceRank:n.sourceRank || 0, observedTs:n.observedTs || 0, nativeKey:n.nativeKey || "", nativeInstance:n.nativeInstance || "", nativeActive:false, icon:n.icon || "",
            }));
          }
          store.followedTeams = d.followedTeams || {};
          if (d.v !== 2) store.notifications = store.notifications.filter(n=>n.service !== "calendar");
          if (d.dismissIds && typeof d.dismissIds === "object") store.dismissIds = d.dismissIds;
          if (d.unpinnedIds && typeof d.unpinnedIds === "object") store.unpinnedIds = d.unpinnedIds;
          if (d.followedGames && typeof d.followedGames === "object") store.followedGames = d.followedGames;
          if (typeof d.titleGameKey === "string") store.titleGameKey = d.titleGameKey;
          if (typeof d.seq === "number") store.seq = d.seq;
          Sources?.sync();
          prune();
          rebindAllTabs();
          renderAll();
        } catch (e) { dlog("load parse failed", e); }
      }).catch(() => {});
    } catch (_e) {}
  }

  function broadcast(sourceWin) {
    prune();
    Sources?.sync();
    saveSoon();
    let payload = "";
    try { payload = JSON.stringify(serialize()); } catch (_e) { return; }
    try {
      Services.obs.notifyObservers(null, OBS_TOPIC, payload);
    } catch (_e) {}
    void sourceWin;
  }

  function applyRemote(json) {
    try {
      const d = JSON.parse(json);
      if (!d || ![1,2].includes(d.v)) return;
      store.seq = d.seq || 0;
      store.followedTeams = d.followedTeams || {};
      store.notifications = (d.notifications || []).map((n) => ({
        id: String(n.id), service: n.service, sourceId: n.sourceId || "",
        account: String(n.account || ""), summary: String(n.summary || ""),
        detail: String(n.detail || ""), url: validHttpsUrl(n.url),
        ts: +n.ts || (n.service === "gmail" ? 0 : Date.now()), seen: !!n.seen, kind: n.kind || "alert",
        game: n.game || null, itemId:n.itemId || "", mailDate:n.mailDate || "", mailTimeKnown:!!n.mailTimeKnown, mailVerified:!!n.mailVerified, githubVerified:!!n.githubVerified, githubTimeKnown:!!n.githubTimeKnown, mailPrecision:n.mailPrecision || "time", sourceRank:n.sourceRank || 0, observedTs:n.observedTs || 0, nativeKey:n.nativeKey || "", nativeInstance:n.nativeInstance || "", nativeActive:!!n.nativeActive, icon:n.icon || "",
      }));
      store.dismissIds = d.dismissIds || {};
      store.unpinnedIds = d.unpinnedIds || {};
      store.followedGames = d.followedGames || {};
      store.titleGameKey = d.titleGameKey || "";
      if (Array.isArray(d.connections)) {
        const localById = new Map(store.connections.map((c) => [c.id, c]));
        store.connections = d.connections.map((c) => {
          const local = localById.get(String(c.id));
          return {
            id: String(c.id), service: c.service, url: c.url, label: c.label,
            containerId: c.containerId | 0, paused: !!c.paused, bgRefresh: !!c.bgRefresh, ical: !!(local ? local.ical : c.ical),
            listKey: c.listKey || "",
            baseline: local ? local.baseline : new Set(c.baseline || []),
            baselineReady: local ? !!local.baselineReady : !!c.baselineReady,
            baselineFp: local ? local.baselineFp : (c.baselineFp || {}),
            lastScanTs: c.lastScanTs || 0, lastOkTs: c.lastOkTs || 0, lastAlertAt:c.lastAlertAt || 0, status: c.status || "",
            reminded: local ? local.reminded : (c.reminded || {}), openedMail:c.openedMail || {}, openedGithub:c.openedGithub || {}, icon:nativeIconUrl(c.icon),
            hasScanned: !!c.hasScanned, actorOk: c.actorOk !== false,
            lastMeta: typeof c.lastMeta === "string" ? c.lastMeta.slice(0, 220) : "",
            lastCount: c.lastCount | 0,
          };
        });
      }
      prune();
      renderAll();
    } catch (_e) {}
  }

  // ------------------------------------------------ actor registration (local module pattern)

  function ensureActorRegistered() {
    try {
      const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      const modDir = profileDir.clone();
      for (const seg of ["chrome", "sine-mods", "workspace-notifications"]) modDir.append(seg);
      const modUri = Services.io.newFileURI(modDir);
      const resProto = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
      if (!resProto.hasSubstitution("workspace-notifications")) {
        resProto.setSubstitution("workspace-notifications", modUri);
      }
    } catch (e) { logEvent("resource substitution failed", {error: String(e)}, "error"); }
    try {
      ChromeUtils.registerWindowActor(ACTOR, {
        parent: { esModuleURI: "resource://workspace-notifications/WorkspaceNotificationsParent.sys.mjs" },
        child: {
          esModuleURI: "resource://workspace-notifications/WorkspaceNotificationsChild.sys.mjs",
          events: { DOMContentLoaded: { capture: true, mozSystemGroup: true } },
        },
        messageManagerGroups: ["browsers"],
        allFrames: false,
        safeForUntrustedWebProcess: true,
      });
      logEvent("actor registered", {safeForUntrustedWebProcess: true}, "info");
    } catch (e) {
      if (e && e.name !== "NotSupportedError") logEvent("actor registration failed", {error: String(e)}, "error");
      else logEvent("actor already registered", {}, "info");
    }
  }

  function actorForBrowser(browser) {
    try {
      return browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR) || null;
    } catch (error) {
      logEvent("actor unavailable", {error: String(error?.message || error)}, "error");
      return null;
    }
  }

  // ------------------------------------------------ tabs

  function allNormalWindows() {
    const out = [];
    try {
      const en = Services.wm.getEnumerator("navigator:browser");
      while (en.hasMoreElements()) {
        const w = en.getNext();
        if (!w || w.closed) continue;
        try { if (w.PrivateBrowsingUtils && w.PrivateBrowsingUtils.isWindowPrivate(w)) continue; } catch (_e) {}
        out.push(w);
      }
    } catch (_e) {}
    return out;
  }

  function tabIdentity(tab) {
    const hints = [];
    for (const a of ["data-url", "zen-origin-url", "data-original-url"]) {
      try { const v = tab.getAttribute(a); if (v) hints.push(v); } catch (_e) {}
    }
    try {
      const p = tab.getAttribute("pending");
      if (p && p !== "true") hints.push(p);
    } catch (_e) {}
    try {
      if (typeof SessionStore !== "undefined") {
        const u = SessionStore.getLazyTabValue(tab, "url");
        if (u) hints.push(u);
      }
    } catch (_e) {}
    try { const s = tab.linkedBrowser?.currentURI?.spec; if (s) hints.push(s); } catch (_e) {}
    try { const img = tab.getAttribute("image"); if (img) hints.push(img); } catch (_e) {}
    try { const l = tab.getAttribute("label") || tab.label; if (l) hints.push(l); } catch (_e) {}
    return hints;
  }

  function tabUrl(tab) {
    try {
      const s = tab.linkedBrowser?.currentURI?.spec;
      if (s && /^https?:/.test(s)) return s;
    } catch (_e) {}
    try {
      if (typeof SessionStore !== "undefined") {
        const u = SessionStore.getLazyTabValue(tab, "url");
        if (u && /^https?:/.test(u)) return u;
      }
    } catch (_e) {}
    for (const h of tabIdentity(tab)) {
      if (/^https?:/.test(h)) return h;
    }
    return "";
  }

  function isSupportedUrl(url) {
    if (!/^https:\/\//i.test(url)) return null;
    try {
      const u = new URL(url);
      const native = nativeServiceForURL(url);
      if (native) return native;
      const h = u.hostname.toLowerCase();
      if (h === "mail.google.com") return "gmail";
      if (h === "calendar.google.com") return "calendar";
      if (h === "github.com") {
        if (/\/[^/]+\/[^/]+\/issues(\/|$|\?)/.test(u.pathname)) return "github";
        if (/\/issues/.test(u.pathname)) return "github";
        if (u.pathname.startsWith("/search")) return "github";
        return "github";
      }
      if (/^(www\.)?google\.[a-z.]+$/i.test(h) || h.endsWith(".google.com")) {
        if (u.pathname.startsWith("/search")) return "scores";
      }
    } catch (_e) {}
    return null;
  }

  function isTabPending(tab) {
    try {
      if (tab.hasAttribute("pending")) return true;
      if (tab.hasAttribute("discarded")) return true;
      if (!tab.linkedPanel) return true;
    } catch (_e) {}
    return false;
  }

  function findTabBySourceId(sourceId) {
    for (const w of allNormalWindows()) {
      try {
        for (const t of w.gBrowser.tabs) {
          try {
            if (typeof SessionStore !== "undefined") {
              const v = SessionStore.getCustomTabValue(t, TAB_VALUE_KEY);
              if (v === sourceId) return { win: w, tab: t };
            }
          } catch (_e) {}
        }
      } catch (_e) {}
    }
    return null;
  }

  function connForSourceId(id) { return store.connections.find((c) => c.id === id) || null; }

  function sendToActor(browser, name, data) {
    try {
      const actor = actorForBrowser(browser);
      if (!actor) { logEvent("send blocked", {message: name, sourceId: data?.sourceId}, "error"); return false; }
      actor.sendAsyncMessage(name, data);
      logEvent("sent", {message: name, sourceId: data?.sourceId});
      return true;
    } catch (e) {
      logEvent("actor send failed", {message: name, error: String(e)}, "error");
      return false;
    }
  }

  function activateOnTab(win, tab, conn, attempt) {
    if (NATIVE_SERVICES.has(conn.service)) {
      try { SessionStore.setCustomTabValue(tab,TAB_VALUE_KEY,conn.id); } catch (_e) {}
      conn.status=Sources?.nativeStatus() || "Waiting for desktop alerts"; Sources?.sync(); return;
    }
    try {
      if (typeof SessionStore !== "undefined") SessionStore.setCustomTabValue(tab, TAB_VALUE_KEY, conn.id);
    } catch (_e) {}
    attempt = attempt || 0;
    logEvent("activate source", {sourceId: conn.id, service: conn.service, attempt});
    let ok = false;
    try {
      const browser = tab.linkedBrowser;
      if (browser) ok = sendToActor(browser, "WorkspaceNotifications:Activate", { sourceId: conn.id, service: conn.service });
    } catch (e) { dlog("activate failed", e); }
    conn.actorOk = ok;
    if (!ok) {
      conn.status = isTabPending(tab) ? "Tab unloaded" : "Waiting for tab…";
      // Retry a few times: the actor may not exist until the content process
      // creates the browsing context (fresh tabs, cold-start restores).
      if (attempt < 8 && !tab.closing) {
        setTimeout(() => {
          try {
            if (tab.closing) return;
            const c = connForSourceId(conn.id);
            if (!c || c.paused) return;
            activateOnTab(win, tab, c, attempt + 1);
          } catch (_e) {}
        }, 900);
      }
      renderAll();
    } else if (attempt > 0) {
      renderAll();
    }
    void win;
  }

  function deactivateOnTab(tab, sourceId, forgetBinding = true) {
    try {
      if (forgetBinding && typeof SessionStore !== "undefined") SessionStore.deleteCustomTabValue(tab, TAB_VALUE_KEY);
    } catch (_e) {}
    try {
      const actor = actorForBrowser(tab.linkedBrowser);
      if (actor) actor.sendAsyncMessage("WorkspaceNotifications:Deactivate", { sourceId });
    } catch (_e) {}
  }

  function rebindAllTabs() {
    for (const conn of store.connections) {
      if (conn.paused) continue;
      const found = findTabBySourceId(conn.id);
      if (found && !isTabPending(found.tab)) {
        activateOnTab(found.win, found.tab, conn);
      }
    }
  }

  // ------------------------------------------------ snapshot handling (shared-store change computation)

  window.WorkspaceNotificationsStore = {
    logDiagnostic(data) {
      const conn = connForSourceId(data?.sourceId);
      if (!conn || conn.paused || data.service !== conn.service) return;
      logEvent("content " + data.stage, {sourceId: conn.id, service: conn.service, ...data.details}, data.level === "error" ? "error" : "debug");
    },
    handleSnapshot(data, bc) {
      try {
        if (isPrivateWindow(window)) return;
        if (!isEnabled()) return;
        const conn = connForSourceId(data.sourceId);
        if (!conn || conn.paused) return;
        // Only the owning window computes changes; others receive the broadcast.
        let owned = false;
        try {
          for (const t of gBrowser.tabs) {
            if (t.linkedBrowser && t.linkedBrowser.browsingContext === bc) { owned = true; break; }
            try {
              if (typeof SessionStore !== "undefined" && SessionStore.getCustomTabValue(t, TAB_VALUE_KEY) === conn.id) { owned = true; break; }
            } catch (_e) {}
          }
        } catch (_e) {}
        if (!owned) return;
        handleSnapshotOwned(conn, data);
      } catch (e) { dlog("handleSnapshot failed", e); }
    },
  };

  function setStatus(conn, status, ok) {
    conn.status = status;
    conn.lastScanTs = Date.now();
    if (ok) conn.lastOkTs = conn.lastScanTs;
  }

  function sourceAccount(conn, snap) {
    if (conn.service === "gmail") {
      const index = (String(conn.url || snap.href).match(/\/mail\/u\/(\d+)/) || [,"0"])[1];
      return "Account " + (Number(index) + 1);
    }
    if (conn.service === "github") return "GitHub";
    if (conn.label) return conn.label;
    try {
      const u = new URL(conn.url || snap.href || "");
      if (conn.service === "github") {
        const m = u.pathname.match(/^\/([^/]+\/[^/]+)/);
        if (m) return m[1];
      }
      return u.hostname;
    } catch (_e) { return SERVICE_LABEL[conn.service] || conn.service; }
  }

  function handleSnapshotOwned(conn, snap) {
    if (!snap || typeof snap !== "object") return;
    if (snap.sourceId !== conn.id) return;
    if (!["gmail", "github", "calendar", "scores"].includes(snap.service)) return;
    if (snap.service !== conn.service || conn.service === "calendar") return;

    const href = typeof snap.href === "string" ? snap.href.slice(0, 500) : "";
    const listKey = typeof snap.listKey === "string" ? snap.listKey : "";
    // Navigation to another list / range / account resets the baseline quietly.
    if (listKey && conn.listKey && listKey !== conn.listKey) {
      conn.listKey = listKey;
      conn.baseline = new Set();
      conn.baselineReady = false;
      conn.baselineFp = {};
      conn.reminded = {};
      dlog("baseline reset (navigation) for", conn.id, listKey);
    } else if (listKey && !conn.listKey) {
      conn.listKey = listKey;
    }

    conn.actorOk = true;
    conn.hasScanned = true;
    logEvent("scan result", {sourceId: conn.id, service: conn.service, reason: snap.reason, ready: snap.ready, items: snap.items?.length || 0, meta: snap.meta}, snap.reason === "manual" ? "info" : "debug");
    try {
      conn.lastMeta = snap.meta && typeof snap.meta === "object" ? JSON.stringify(snap.meta).slice(0, 220) : "";
      conn.lastCount = Array.isArray(snap.items) ? snap.items.length : 0;
    } catch (_e) {}
    dlog("snapshot", conn.service, "ready=" + snap.ready, "items=" + (snap.items || []).length, "meta=" + (conn.lastMeta || ""));

    if (snap.unsupported) {
      setStatus(conn, "Unsupported page", false);
      broadcast(window);
      renderAll();
      return;
    }
    if (snap.signin) {
      setStatus(conn, "Sign-in required", false);
      broadcast(window);
      renderAll();
      return;
    }
    if (!snap.ready) {
      setStatus(conn, String(snap.meta?.reason || snap.meta?.error || "Waiting for page…").slice(0,180), false);
      broadcast(window);
      renderAll();
      return;
    }

    const items = Array.isArray(snap.items) ? snap.items.slice().sort((a,b)=>(b.ts||0)-(a.ts||0)).slice(0, 50) : [];
    const isFirst = !conn.baselineReady;
    const account = sourceAccount(conn, snap);
    let changed = false;

    if (conn.service === "scores") {
      changed = ingestScores(conn, items, account, !!snap.navigated) || changed;
    } else {
      const res = conn.service === "gmail" ? ingestGmail(conn, items, account, isFirst, snap.meta || {}) : conn.service === "github" ? ingestGitHub(conn,items,isFirst) : ingestListWrapped(conn, items, account, isFirst);
      conn.baselineReady = true;
      changed = res.changed || changed;
    }

    setStatus(conn, conn.paused ? "Paused" : "Monitoring", true);
    if (changed) broadcast(window);
    else saveSoon();
    renderAll();
  }

  function ingestGmail(conn, items, account, isFirst, meta) {
    const previous = store.notifications.filter(n => n.service === "gmail" && n.sourceId === conn.id);
    const byItem = new Map(previous.map(n => [notifItemKey(n), n]));
    conn.openedMail ||= {};
    for (const id of meta.readIds || []) delete conn.openedMail[id];
    const reported = new Set(items.map(item=>item.id));
    // Unread snapshots are a current inbox view, not a notification archive.
    // Leaving the rendered list hides an item; it never deletes email.
    for (const id of Object.keys(conn.openedMail)) if (!reported.has(id)) delete conn.openedMail[id];
    store.notifications = store.notifications.filter(n => !(n.service === "gmail" && n.sourceId === conn.id));
    const next = [];
    for (const item of items) {
      if (!item?.id || item.meta?.unread === false) continue;
      const old = byItem.get(item.id), fp = String(item.fingerprint || "");
      if (conn.openedMail[item.id] === fp) continue; // Suppress a cached snapshot after opening.
      const base = "n-" + conn.id + "-" + item.id;
      const id = base + (fp ? "-r" + fp.slice(0,8) : "");
      if (store.dismissIds[id] || store.dismissIds[base]) continue;
      const ts = Number(item.ts), known = Number.isFinite(ts) && ts > 0;
      const n = {id, itemId:item.id, service:"gmail", sourceId:conn.id, account,
        summary:String(item.summary || "(No subject)").slice(0,240), detail:String(item.detail || "").slice(0,300),
        url:validHttpsUrl(item.url), ts:known ? ts : 0, observedTs:old?.observedTs || Date.now(), mailTimeKnown:known, mailPrecision:item.meta?.precision || "time", sourceRank:item.meta?.sourceRank || 0,
        mailDate:String(item.meta?.date || "").slice(0,100), mailVerified:true, seen:old?.seen ?? isFirst, kind:"alert"};
      next.push(n);
      if (!isFirst && (!conn.baseline.has(item.id) || conn.baselineFp[item.id] !== fp)) onNewBrief(n);
    }
    store.notifications = [...next, ...store.notifications];
    conn.baseline = reported;
    conn.baselineFp = Object.fromEntries(items.map(item=>[item.id,String(item.fingerprint || "")]));
    return {changed:JSON.stringify(previous) !== JSON.stringify(next)};
  }

  function ingestList(conn, items, account, isFirst) {
    let changed = false;
    const seenNow = new Set();
    for (const it of items) {
      if (!it || typeof it.id !== "string" || !it.id) continue;
      const id = it.id.slice(0, 300);
      const fp = typeof it.fingerprint === "string" ? it.fingerprint : "";
      const summary = String(it.summary || "").slice(0, 240);
      const detail = String(it.detail || "").slice(0, 300);
      const url = validHttpsUrl(it.url);
      seenNow.add(id);
      const had = conn.baseline && conn.baseline.has(id);
      const oldFp = conn.baselineFp ? conn.baselineFp[id] : "";
      if (isFirst) {
        // Establish initial baseline without a title-alert burst.
        conn.baseline.add(id);
        if (fp) conn.baselineFp[id] = fp;
        if (conn.service === "gmail") {
          // …but show existing unread threads in the feed quietly (seen,
          // no 6-second title takeover). New arrivals alert normally.
          const nid = "n-" + conn.id + "-" + id;
          if (!store.dismissIds[nid] && !store.notifications.some((n) => n.id === nid)) {
            pushQuiet({
              id: nid, service: conn.service, sourceId: conn.id, account,
              summary: summary || "(No subject)", detail, url,
              ts: typeof it.ts === "number" ? it.ts : Date.now(), kind: "alert", seen: true,
            });
            changed = true;
          }
        }
        continue;
      }
      if (!had) {
        // Deduplicate against dismissals and existing notifications.
        const nid = "n-" + conn.id + "-" + id;
        if (!store.dismissIds[nid] && !store.notifications.some((n) => n.id === nid)) {
          pushNotification({
            id: nid, service: conn.service, sourceId: conn.id, account,
            summary: summary || "(New item)", detail, url,
            ts: typeof it.ts === "number" ? it.ts : Date.now(), kind: "alert",
          });
          changed = true;
        }
        conn.baseline.add(id);
        if (fp) conn.baselineFp[id] = fp;
      } else if (fp && oldFp && fp !== oldFp) {
        // Detectable revision (new message in thread / edited event).
        const nid = "n-" + conn.id + "-" + id + "-r" + fp.slice(0, 8);
        if (!store.dismissIds[nid] && !store.notifications.some((n) => n.id === nid)) {
          pushNotification({
            id: nid, service: conn.service, sourceId: conn.id, account,
            summary: summary || "(Updated)", detail: detail || "Updated",
            url, ts: Date.now(), kind: "alert",
          });
          changed = true;
        }
        conn.baselineFp[id] = fp;
      }
    }
    // NOTE: never infer deletion from disappearance offscreen (visible-list window).
    return { changed };
  }

  function pushNotification(n) {
    if(store.dismissIds[n.id] || store.notifications.some(x=>x.id===n.id))return;
    prune();
    store.seq++;
    store.notifications.unshift(n);
    store.notifications = store.notifications.sort(compareNotifications).slice(0, MAX_NOTIFICATIONS);
    onNewBrief(n);
  }

  function pushQuiet(n) {
    if(store.dismissIds[n.id] || store.notifications.some(x=>x.id===n.id))return;
    prune();
    store.seq++;
    store.notifications.unshift(n);
    store.notifications = store.notifications.sort(compareNotifications).slice(0, MAX_NOTIFICATIONS);
  }

  // ------------------------------------------------ games

  function gameKeyFor(meta, itemId) {
    if (meta && meta.home && meta.away) return "game:" + (meta.away + " v " + meta.home).toLowerCase();
    return itemId;
  }

  function ingestScores(conn, items, account, navigated) {
    let changed = false;
    void navigated;
    if (items.some((it) => it.meta?.home && it.meta?.away)) {
      for (const [key, game] of Object.entries(store.followedGames)) {
        if (game.sourceId === conn.id && game.manual) {
          if (store.titleGameKey === key && !game.dismissed) conn.followNextGame = true;
          delete store.followedGames[key];
          if (store.titleGameKey === key) store.titleGameKey = "";
        }
      }
    }
    for (const it of items) {
      const meta = it.meta || {};
      if (!meta.supported && !meta.home) {
        setStatus(conn, "Unsupported page", false);
        continue;
      }
      const key = gameKeyFor(meta, it.id);
      // Transfer an existing selection when old container text included the
      // short name and record alongside the actual team name.
      for (const [oldKey, old] of Object.entries(store.followedGames)) {
        if (oldKey === key || old.sourceId !== conn.id) continue;
        if (String(old.away).includes(meta.away) && String(old.home).includes(meta.home)) {
          if (store.titleGameKey === oldKey && !old.dismissed) conn.followNextGame = true;
          for (const notification of store.notifications) {
            if (notification.game?.key !== oldKey) continue;
            notification.summary = notification.summary.replace(old.away, meta.away).replace(old.home, meta.home);
            Object.assign(notification.game, {key, away:meta.away, home:meta.home, awayIcon:teamIconUrl(meta.awayIcon), homeIcon:teamIconUrl(meta.homeIcon)});
          }
          delete store.followedGames[oldKey]; changed = true;
        }
      }
      const requestedFollow = !!conn.followNextGame;
      if (requestedFollow) {
        conn.followNextGame = false;
        store.titleGameKey = key;
        if (store.followedGames[key]) {
          store.followedGames[key].dismissed = false;
          store.followedGames[key].pinFinal = /final/i.test(meta.status || "");
        }
      }
      const prev = store.followedGames[key];
      const status = String(meta.status || "").slice(0, 80);
      const hs = String(meta.homeScore != null ? meta.homeScore : "");
      const as = String(meta.awayScore != null ? meta.awayScore : "");
      const summary = String(it.summary || "").slice(0, 200);
      if (!prev) {
        // Newly observed match card: record but do not alert until followed.
        if (!store.followedGames[key]) {
          store.followedGames[key] = {
            id: key, sourceId: conn.id, home: meta.home || "", away: meta.away || "",
            homeScore: hs, awayScore: as, homeIcon: teamIconUrl(meta.homeIcon), awayIcon: teamIconUrl(meta.awayIcon), sport: meta.sport || "", status, lastUpdate: Date.now(),
            dismissed: false, showInTitle: requestedFollow, pinFinal: requestedFollow && /final/i.test(status), account,
          };
          changed = true;
          // Frictionless live scores: an explicitly connected tab showing a
          // single live game follows it automatically for the title.
          try {
            const mine = Object.entries(store.followedGames).filter(([, gg]) => gg.sourceId === conn.id && !gg.dismissed);
            if (mine.length === 1 && (!store.titleGameKey || (store.followedGames[store.titleGameKey] || {}).dismissed)) {
              if (isLiveStatus(status)) {
                store.titleGameKey = key;
                store.followedGames[key].showInTitle = true;
              }
            }
          } catch (_e) {}
        }
        continue;
      }
      const iconChanged = (teamIconUrl(meta.homeIcon) && teamIconUrl(meta.homeIcon) !== prev.homeIcon) || (teamIconUrl(meta.awayIcon) && teamIconUrl(meta.awayIcon) !== prev.awayIcon);
      if (iconChanged || requestedFollow) changed = true;
      const scoreChanged = prev.homeScore !== hs || prev.awayScore !== as;
      const statusChanged = prev.status !== status;
      prev.homeScore = hs; prev.awayScore = as; prev.status = status;
      prev.home = meta.home || prev.home; prev.away = meta.away || prev.away;
      prev.homeIcon = teamIconUrl(meta.homeIcon) || prev.homeIcon || "";
      prev.awayIcon = teamIconUrl(meta.awayIcon) || prev.awayIcon || "";
      prev.sport = meta.sport || prev.sport || "";
      prev.lastUpdate = Date.now(); prev.account = account; prev.sourceId = conn.id;
      if (scoreChanged && !prev.dismissed) {
        // Update one existing game item as its score changes; clock ticks alone do nothing.
        const nid = "n-game-" + key.replace(/[^a-z0-9]+/gi, "").slice(0, 40) + "-" + hs + "-" + as;
        if (!store.dismissIds[nid]) {
          pushNotification({
            id: nid, service: "scores", sourceId: conn.id, account,
            summary: summary || (prev.away + " " + as + " – " + hs + " " + prev.home),
            detail: status, url: validHttpsUrl(it.url), ts: Date.now(), kind: "game",
            game: { key, ...scoreSnapshot(prev) },
          });
          changed = true;
        }
        if (!store.titleGameKey || (store.followedGames[store.titleGameKey] || {}).dismissed) {
          if (isLiveStatus(status)) { store.titleGameKey = key; prev.showInTitle = true; }
        }
      } else if (statusChanged) {
        if (/final/i.test(status) && !prev.dismissed) {
          finalScore(key, prev, account, conn.id, validHttpsUrl(it.url));
          changed = true;
        } else if (isLiveStatus(status) && !store.titleGameKey) {
          store.titleGameKey = key;
        }
      }
    }
    return changed;
  }

  function isLiveStatus(s) { return /live|q\d|half|quarter|inning|period|ot\b/i.test(s || ""); }

  function finalScore(key, g, account, sourceId, url) {
    const nid = "n-game-final-" + key.replace(/[^a-z0-9]+/gi, "").slice(0, 40);
    if (store.dismissIds[nid]) return;
    pushNotification({
      id: nid, service: "scores", sourceId, account,
      summary: "Final: " + g.away + " " + g.awayScore + " – " + g.homeScore + " " + g.home,
      detail: "Final", url, ts: Date.now(), kind: "game", game: { key, final: true, ...scoreSnapshot(g) },
    });
    g.finalShownTs = Date.now();
  }

  // ------------------------------------------------ title presentation

  let titleState = {
    bound: null, bar: null, overlay: null, textEl: null,
    editing: false,
    indicatorHovered: false,
  };

  function findIndicator() {
    try { if (window.gZenWorkspaces?.activeWorkspaceIndicator?.isConnected) return window.gZenWorkspaces.activeWorkspaceIndicator; } catch (_e) {}
    return document.querySelector(".zen-current-workspace-indicator");
  }
  function isEditing() {
    try {
      if (document.documentElement.hasAttribute("zen-renaming-tab")) {
        const inp = document.getElementById("tab-label-input");
        if (inp) {
          const ind = findIndicator();
          if (ind && (ind.contains(inp) || inp.closest(".zen-current-workspace-indicator"))) return true;
        }
      }
      const ind = findIndicator();
      if (ind && ind.querySelector("input, textarea")) return true;
    } catch (_e) {}
    return false;
  }

  function gameActive(g) {
    if (g.provider === "espn") return Object.values(store.followedTeams).some(t=>!t.paused && t.league===g.league && g.teamIds?.includes(t.id));
    const c=connForSourceId(g.sourceId); return !!c && !c.paused;
  }
  function gameIsLive(g) { return g.provider === "espn" ? g.state === "in" : isLiveStatus(g.status); }
  // Newest verified notification, kept on the workspace indicator until the
  // user dismisses or opens it. Score-progress updates are excluded here;
  // they show through the live-score board path instead. Unpinned items stay
  // in the feed but never take the indicator.
  function currentPinnedNotification() {
    if (isPrivateWindow(window) || !isEnabled()) return null;
    const cands = store.notifications.filter((n) =>
      !store.dismissIds[n.id] &&
      !store.unpinnedIds[n.id] &&
      (n.service !== "gmail" || n.mailVerified) &&
      (n.service !== "github" || n.githubVerified) &&
      !(n.kind === "game" && !n.game?.final));
    if (!cands.length) return null;
    cands.sort(compareNotifications);
    return cands[0];
  }

  // Minus button on the indicator: hide this item from the workspace display
  // but keep its card in the notification center.
  function unpinFromIndicator() {
    const pinned = currentPinnedNotification();
    if (!pinned) return false;
    store.unpinnedIds[pinned.id] = Date.now();
    if (pinned.kind === "game" && pinned.game?.key && store.followedGames[pinned.game.key]) {
      if (store.titleGameKey === pinned.game.key) store.titleGameKey = "";
    }
    broadcast(window);
    renderAll();
    return true;
  }
  function currentScoreGame() {
    if (isPrivateWindow(window) || !isEnabled()) return null;
    const chosen=store.followedGames[store.titleGameKey];
    if (chosen && chosen.showInTitle && !chosen.dismissed && !chosen.manual && gameActive(chosen) && (gameIsLive(chosen) || chosen.pinFinal)) return {key:store.titleGameKey,g:chosen};
    const games=Object.entries(store.followedGames).filter(([,g])=>!g.manual && !g.dismissed && gameActive(g) && gameIsLive(g)).sort((a,b)=>(a[1].startTs||a[1].lastUpdate)-(b[1].startTs||b[1].lastUpdate));
    return games.length ? {key:games[0][0],g:games[0][1]} : null;
  }

  function teamIconUrl(value) {
    if (typeof value !== "string") return "";
    if (/^data:image\/(?:png|webp|jpeg|gif);base64,[a-z0-9+/=]+$/i.test(value) && value.length < 100000) return value;
    // Logo URLs can contain long provider parameters; truncation corrupts them.
    try {return value.length <= 16000 && new URL(value).protocol === "https:" ? value : "";} catch (_e) {return "";}
  }

  function scoreSnapshot(g) {
    return {away: g.away, home: g.home, awayScore: g.awayScore, homeScore: g.homeScore,
      awayAbbr:g.awayAbbr || "", homeAbbr:g.homeAbbr || "", awayIcon: g.awayIcon || "", homeIcon: g.homeIcon || "", sport: g.sport || "", status: g.status || ""};
  }

  function scoreBoard(g) {
    const board = document.createElement("span");
    board.className = "wn-scoreboard";
    board.setAttribute("role", "img");
    board.setAttribute("aria-label", scoreText(g));
    board.title = scoreText(g);
    const logo = (name, url, abbreviation) => {
      const slot = document.createElement("span"); slot.className = "wn-team-logo";
      slot.setAttribute("aria-hidden", "true");
      if (teamIconUrl(url)) {
        const img = document.createElement("img");
        img.src = teamIconUrl(url); img.alt = "";
        img.setAttribute("referrerpolicy", "no-referrer");
        img.onerror=()=>{img.remove(); slot.classList.add("wn-team-initials"); slot.textContent=abbreviation || String(name||"?").split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();};
        slot.appendChild(img);
      } else {
        slot.classList.add("wn-team-initials");
        slot.textContent = abbreviation || String(name || "?").split(/\s+/).map((word) => word[0]).slice(0, 2).join("").toUpperCase();
      }
      return slot;
    };
    // Visible strip is icons + score only; full team names stay in the
    // aria-label/title (scoreText) and in the live menu card caption.
    const hasScores = g.awayScore !== "" && g.awayScore != null && g.homeScore !== "" && g.homeScore != null;
    const line = document.createElement("span");
    line.className = "wn-score-line";
    line.setAttribute("aria-hidden", "true");
    line.textContent = hasScores ? g.awayScore + " \u2013 " + g.homeScore : "vs";
    board.append(logo(g.away, g.awayIcon, g.awayAbbr), line, logo(g.home, g.homeIcon, g.homeAbbr));
    return board;
  }

  function paintTitleContent(text, game = null) {
    const signature = game ? JSON.stringify([game.away, game.home, game.awayAbbr, game.homeAbbr, game.awayScore, game.homeScore, game.awayIcon, game.homeIcon, game.status]) : text;
    if (titleState.contentSignature === signature) return;
    titleState.contentSignature = signature;
    if (game) {
      const fresh = document.createElement("span"); fresh.appendChild(scoreBoard(game));
      reconcileChildren(titleState.textEl, fresh);
    } else titleState.textEl.textContent = text;
  }

  function scoreText(g) {
    return g.away + " " + g.awayScore + " – " + g.homeScore + " " + g.home + (g.status ? " · " + g.status : "");
  }

  function onNewBrief(n) {
    if (isPrivateWindow(window) || !isEnabled()) return;
    // The indicator derives the pinned notification from the store, so new
    // arrivals appear there and stay until dismissed or opened. No timers.
    void n;
    renderTitle();
  }

  function paintOverlay() {
    const { overlay, textEl } = titleState;
    if (!overlay || !textEl) return;
    const enabled = isEnabled() && !isPrivateWindow(window) && !isEditing();
    const pinned = currentPinnedNotification();
    const score = currentScoreGame();
    // Incoming notifications take the workspace icon and stay there until
    // dismissed or opened; live scores use it only when nothing is pinned.
    const iconNotif = enabled ? pinned : null;
    paintWorkspaceGameIcon(enabled ? score?.g || null : null, iconNotif);
    if (titleState.unpinBtn) titleState.unpinBtn.hidden = !(enabled && pinned);
    if (titleState.bar) titleState.bar.classList.toggle("wn-ind-hover", !!titleState.indicatorHovered);
    if (!isEnabled() || isPrivateWindow(window) || isEditing()) {
      overlay.classList.remove("wn-show");
      return;
    }
    if (pinned) {
      const pinnedGame = pinned.game?.away ? pinned.game : (pinned.game?.key ? store.followedGames[pinned.game.key] : null);
      paintTitleContent(pinnedGame ? "" : pinned.summary, pinnedGame);
      overlay.classList.add("wn-show");
      overlay.classList.add(pinnedGame ? "wn-score" : "wn-brief");
      overlay.classList.remove(pinnedGame ? "wn-brief" : "wn-score", "wn-cal");
    } else if (score) {
      paintTitleContent("", score.g);
      overlay.classList.add("wn-show");
      overlay.classList.add("wn-score");
      overlay.classList.remove("wn-brief", "wn-cal");
    } else {
      overlay.classList.remove("wn-show", "wn-brief", "wn-score", "wn-cal");
    }
    updateIndicatorDescription();
  }

  function renderTitle() { renderAll(); }

  function paintWorkspaceGameIcon(game, notif) {
    const src = notif || (game ? { service: "scores", sourceId: game.sourceId, url: game.url } : null);
    titleState.bound?.classList.toggle("wn-game-present", !!src);
    const icon = titleState.bound?.querySelector(".zen-current-workspace-indicator-icon");
    if (!icon) return;
    let glyph = icon.querySelector(".wn-workspace-game-icon");
    const slots = [icon, icon.closest(".zen-current-workspace-indicator-stack")].filter(Boolean);
    icon.classList.toggle("wn-game-icon-active", !!src);
    if (!src) {
      glyph?.remove();
      for (const slot of slots) if (Object.hasOwn(slot, "_wnNoIcon")) {
        if (slot._wnNoIcon === null) slot.removeAttribute("no-icon"); else slot.setAttribute("no-icon", slot._wnNoIcon);
        delete slot._wnNoIcon;
      }
      return;
    }
    for (const slot of slots) {
      if (!Object.hasOwn(slot,"_wnNoIcon")) slot._wnNoIcon = slot.getAttribute("no-icon");
      slot.removeAttribute("no-icon");
    }
    if (!glyph) {
      glyph = document.createElement("span"); glyph.className = "wn-workspace-game-icon";
      glyph.setAttribute("aria-hidden", "true"); icon.appendChild(glyph);
    }
    glyph.textContent = "";
    glyph.classList.remove("wn-native-football");
    glyph.style.removeProperty("--wn-sport-icon");
    // Native tab favicon where one exists, Tabler glyph for tab-free feeds.
    const image = appIcon({ service: src.service || "scores", sourceId: src.sourceId, url: src.url || connForSourceId(src.sourceId)?.url });
    const existing = glyph.querySelector("[data-wn-src]");
    if (existing && existing.localName === "img" && image.localName === "img") { if (existing.getAttribute("src") !== image.getAttribute("src")) existing.src = image.src; }
    else if (!existing || existing.dataset.wnSrc !== image.dataset.wnSrc) glyph.replaceChildren(image);
    titleState.bound.classList.add("wn-game-present");
  }

  function updateIndicatorDescription() {
    const bar = titleState.bar;
    if (!bar) return;
    const n = store.notifications.filter((x) => !store.dismissIds[x.id] && !x.seen && (x.service !== "gmail" || x.mailVerified) && (x.service !== "github" || x.githubVerified)).length;
    const pinned = currentPinnedNotification();
    const game = currentScoreGame();
    const lead = pinned ? (pinned.game?.away ? scoreText(pinned.game) + ". " : pinned.summary + ". ") : game ? scoreText(game.g) + ". " : "";
    bar.setAttribute("aria-label", lead + n + " unread notifications. Open notifications.");
  }

  function ensureTitleBound() {
    const ind = findIndicator();
    if (!ind) return;
    if (titleState.bound === ind && ind.contains(titleState.overlay)) return;
    // Clean previous.
    paintWorkspaceGameIcon(null);
    titleState.bar?.remove();
    if (titleState.overlay && titleState.overlay.parentNode) {
      try { titleState.overlay.parentNode.removeChild(titleState.overlay); } catch (_e) {}
    }
    titleState.bound = ind;
    titleState.indicatorHovered = false;
    const menu = ind.querySelector(".zen-workspaces-actions");
    const bar = document.createElement("div");
    bar.className = "wn-notification-bar";
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("role", "button");
    bar.setAttribute("aria-haspopup", "dialog");
    bar.setAttribute("aria-expanded", "false");
    bar.setAttribute("aria-controls", "wn-feed-panel");
    bar.addEventListener("keydown", (e) => {
      if (e.target?.closest?.(".wn-unpin")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openFeedPanel(ind, true); }
    });
    ind.insertBefore(bar, menu || null);
    titleState.bar = bar;
    // Status display in the row before the native workspace action/menu button.
    const overlay = document.createElement("div");
    overlay.className = "wn-title-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const txt = document.createElement("span");
    txt.className = "wn-title-text";
    overlay.appendChild(txt);
    try {
      const pos = window.getComputedStyle(ind).position;
      if (pos === "static") ind.style.position = "relative";
    } catch (_e) {}
    bar.appendChild(overlay);
    // Minus button at the far right end of the bar, where the workspace more
    // options button usually sits: unpins the shown item from the workspace
    // display while keeping its card in the notification center. CSS reveals
    // it on bar hover/focus and shrinks the text so it fits the container.
    const unpin = document.createElement("button");
    unpin.type = "button"; unpin.className = "wn-unpin";
    unpin.title = "Remove from workspace indicator"; unpin.setAttribute("aria-label", "Remove from workspace indicator");
    unpin.appendChild(wnIcon("minus"));
    unpin.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); unpinFromIndicator(); });
    bar.appendChild(unpin);
    titleState.unpinBtn = unpin;
    bar.addEventListener("click", (e) => { e.stopPropagation(); openFeedPanel(bar, true); });
    bar.addEventListener("dblclick", (e) => e.stopPropagation());
    titleState.overlay = overlay;
    titleState.textEl = txt;
    titleState.contentSignature = null;
    attachTitleHover(ind);
    ind.addEventListener("keydown", (e) => {
      if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); openFeedPanel(ind, true); }
    });
    paintOverlay();
  }

  // ------------------------------------------------ anchored popup (native XUL)

  let feedPanel = null;
  let showTimer = 0, hideTimer = 0;
  let panelPinned = false, panelView = "feed", renderTimer = 0;
  let panelHovered = false;

  function hoverDelay() { return clamp(getPref("hover-delay-ms", 250) || 250, 0, 2000); }

  function attachTitleHover(ind) {
    if (!ind || ind.hasAttribute("data-wn-hover")) return;
    ind.setAttribute("data-wn-hover", "true");
    ind.addEventListener("mouseenter", () => {
      if (ind !== titleState.bound) return;
      titleState.indicatorHovered = true;
      // Hovering any part of the workspace indicator reveals the minus.
      titleState.bar?.classList.add("wn-ind-hover");
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        showTimer = 0;
        if (ind !== titleState.bound || !titleState.indicatorHovered || isFeedOpen() || isEditing()) return;
        openFeedPanel(ind);
      }, hoverDelay());
    });
    ind.addEventListener("mouseleave", () => { if (ind === titleState.bound) titleState.indicatorHovered = false; titleState.bar?.classList.remove("wn-ind-hover"); scheduleHide(); });
    ind.addEventListener("contextmenu", () => hidePanels(), {capture: true});
  }

  function scheduleHide() {
    if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = 0;
      try {
        if (panelHovered || titleState.indicatorHovered) return;
      } catch (_e) {}
      hidePanels();
    }, 300);
  }

  function ensurePanels() {
    if (!feedPanel) {
      feedPanel = document.createElementNS(XUL_NS, "panel");
      feedPanel.id = "wn-feed-panel";
      feedPanel.setAttribute("type", "arrow");
      feedPanel.setAttribute("nonnativepopover", "true");
      feedPanel.setAttribute("orient", "vertical");
      feedPanel.setAttribute("side", "left");
      feedPanel.setAttribute("noautohide", "false");
      feedPanel.setAttribute("noautofocus", "true");
      feedPanel.setAttribute("role", "dialog");
      feedPanel.setAttribute("aria-label", "Workspace notifications");
      feedPanel.setAttribute("level", "top");
      const wrap = document.createElement("div");
      wrap.className = "wn-wrap";
      feedPanel.appendChild(wrap);
      document.documentElement.appendChild(feedPanel);
      feedPanel.addEventListener("mouseenter", () => { panelHovered = true; if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; } });
      feedPanel.addEventListener("mouseleave", () => { panelHovered = false; scheduleHide(); });
      feedPanel.addEventListener("popuphidden", (e) => {
        if (e.target !== feedPanel) return;
        panelPinned = false;
        panelHovered = false;
        if (titleState.bar) titleState.bar.setAttribute("aria-expanded", "false");
      });
      feedPanel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); hidePanels(); titleState.bar?.focus(); } });
    }
  }

  function hidePanels() {
    if (showTimer) { clearTimeout(showTimer); showTimer = 0; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    panelPinned = false;
    try { if (feedPanel) feedPanel.hidePopup(); } catch (_e) {}
  }

  function isFeedOpen() { try { return feedPanel && feedPanel.state === "open"; } catch (_e) { return false; } }

  // The standalone Notifications feed is gone; the indicator opens the
  // Sources panel straight into the identical Inbox list.
  function openFeedPanel(anchor, pinned = false) {
    if (isPrivateWindow(window) || !isEnabled() || isEditing()) return;
    ensurePanels();
    panelPinned = panelPinned || pinned;
    panelView = "sources";
    sourceView = "inbox";
    sourceDetailId = "";
    renderSourcesPanel();
    const ind = anchor || findIndicator() || document.documentElement;
    if (!isFeedOpen()) {
      try { feedPanel.openPopup(ind, "end_before", 4, 0); } catch (_e) {}
    }
    if (titleState.bar) titleState.bar.setAttribute("aria-expanded", "true");
    if (pinned) feedPanel.querySelector("button")?.focus();
  }

  function openSourcesPanel() {
    if (isPrivateWindow(window) || !isEnabled()) return;
    panelPinned = true;
    panelView = "sources";
    ensurePanels();
    renderSourcesPanel();
    if (!isFeedOpen()) {
      try { feedPanel.openPopup(findIndicator() || document.documentElement, "end_before", 4, 0); } catch (_e) {}
    }
    titleState.bar?.setAttribute("aria-expanded", "true");
    feedPanel.querySelector("button")?.focus();
  }

  function connStatusText(c) {
    if (NATIVE_SERVICES.has(c.service)) {
      if (c.paused) return "Paused";
      if (c.ical) return c.status || "Waiting for first poll…";
      // A throwing permission lookup must never break panel rendering.
      try {
        const found = findTabBySourceId(c.id);
        if (found && !isTabPending(found.tab)) {
          const current=tabUrl(found.tab);
          if (current && new URL(current).origin!==new URL(c.url).origin) return "Tab changed sites — open the connected app";
        }
        const principal = found?.tab.linkedBrowser?.contentPrincipal;
        if (nativeServiceForURL(principal?.URI?.prePath) === c.service) {
          let perm = -1;
          try { perm = Services.perms.testPermissionFromPrincipal(principal, "desktop-notification"); } catch (_e) {}
          if (perm === Ci.nsIPermissionManager.DENY_ACTION) return "Blocked: allow notifications in the app site permissions";
          if (perm !== Ci.nsIPermissionManager.ALLOW_ACTION) return "Allow desktop notifications in the app and Zen";
        }
      } catch (_e) {}
      if (!findTabBySourceId(c.id)) return "Open the connected app to receive alerts";
      return (Sources?.nativeStatus() || "Waiting for desktop alerts") + (c.lastAlertAt ? " · last alert " + fmtTime(c.lastAlertAt) : " · no alerts yet");
    }
    const age = c.lastOkTs ? " · " + fmtTime(c.lastOkTs) : "";
    let base;
    if (c.paused) base = "Paused";
    else if (!c.hasScanned) base = "Waiting for first scan…";
    else if (!c.status) base = "Monitoring";
    else base = c.status;
    if (c.actorOk === false && !c.paused) return "Waiting for tab - open it, then scan again";
    return base + age;
  }

  // Shared notification list (live cards + chronological alerts), identical in
  // the Notifications feed and the Sources inbox view.
  function buildFeedList(list, undism) {
    if (!undism.length) {
      const e = document.createElement("div");
      e.className = "wn-empty";
      e.textContent = store.connections.length === 0
        ? "Add an app or team from Apps to get started."
        : "All caught up. New updates from your connected tabs will appear here.";
      list.appendChild(e);
    }
    const ongoing = Object.entries(store.followedGames).filter(([, game]) => !game.dismissed && !game.manual && gameIsLive(game) && gameActive(game));
    const nativeLive=undism.filter(n=>n.nativeActive && !connForSourceId(n.sourceId)?.paused);
    if (ongoing.length || nativeLive.length) {
      const heading = document.createElement("div"); heading.className = "wn-section-label"; heading.textContent = "Live notifications"; heading.setAttribute("data-wn-key", "live-heading"); list.prepend(heading);
      for (const [key, game] of ongoing) {
        const card = document.createElement("div"); card.className = "wn-live-card"; card.tabIndex=0;card.setAttribute("role","button"); card.setAttribute("data-wn-key", "live-" + key);
        card.setAttribute("aria-label", "Open live game: " + scoreText(game));
        const status = document.createElement("span"); status.className = "wn-live-status"; status.textContent = "LIVE · " + game.status;
        const names = document.createElement("span"); names.className = "wn-match-caption"; names.textContent = game.away + " vs " + game.home;
        card.append(status, scoreBoard(game), names);
        card.onclick = () => openNotification({sourceId:game.sourceId, url:game.url || connForSourceId(game.sourceId)?.url || "", id:"live-"+key, game:{key}});
        card.onkeydown=e=>{if(e.key==="Enter" || e.key===" ") {e.preventDefault();openNotification({sourceId:game.sourceId,url:game.url || connForSourceId(game.sourceId)?.url});}};
        const pin=document.createElement("button");pin.className="wn-btn wn-small";pin.textContent=store.titleGameKey===key ? "In workspace" : "Show in workspace";
        pin.onclick=e=>{e.stopPropagation();store.titleGameKey=key;game.showInTitle=true;broadcast(window);renderAll();};card.append(pin);
        list.appendChild(card);
      }
      for (const n of nativeLive) {
        const card = document.createElement("div");
        card.className = "wn-live-card"; card.tabIndex = 0; card.setAttribute("role", "button");
        card.setAttribute("data-wn-key", n.id);
        card.setAttribute("aria-label", "Open calendar reminder: " + n.summary);
        const title = document.createElement("span"); title.className = "wn-live-status"; title.textContent = n.summary;
        const body = document.createElement("span"); body.className = "wn-match-caption"; body.textContent = n.detail;
        if (teamIconUrl(n.icon)) { const icon = document.createElement("img"); icon.src = n.icon; icon.alt = ""; icon.className = "wn-source-logo"; card.append(icon); }
        card.append(title, body);
        const openCal = () => { n.seen = true; broadcast(window); openNotification(n); };
        card.onclick = (e) => { if (!e.target.closest("button")) openCal(); };
        card.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button")) { e.preventDefault(); openCal(); } };
        const dis = document.createElement("button");
        dis.type = "button"; dis.className = "wn-btn wn-dismiss"; dis.title = "Dismiss";
        dis.appendChild(wnIcon("close"));
        dis.setAttribute("aria-label", "Dismiss calendar reminder");
        dis.onclick = (e) => { e.stopPropagation(); dismissNotification(n.id); };
        card.append(dis);
        list.append(card);
      }
      list.querySelector(".wn-empty")?.remove();
    }
    const alerts = undism.filter(n => !n.nativeActive && !(n.kind === "game" && ongoing.some(([key]) => n.game?.key === key))).sort(compareNotifications);
    if (alerts.length) {
      const heading = document.createElement("div"); heading.className = "wn-section-label"; heading.textContent = "Notifications"; heading.setAttribute("data-wn-key", "alerts-heading"); list.appendChild(heading);
    }
    for (const n of alerts.slice(0, 60)) {
      const item = document.createElement("div");
      item.setAttribute("data-wn-key", n.id);
      item.className = "wn-item" + (n.seen ? "" : " wn-unseen");
      const top = document.createElement("div");
      top.className = "wn-item-top";
      const svc = document.createElement("span");
      svc.className = "wn-svc wn-svc-" + n.service;
      svc.append(appIcon(n), document.createTextNode(SERVICE_LABEL[n.service] || n.service));
      top.appendChild(svc);
      const ts = document.createElement("span");
      ts.className = "wn-ts";
      ts.textContent = n.service === "github" && !n.githubTimeKnown ? "" : notificationTime(n);
      if (n.service === "gmail" && n.mailTimeKnown) ts.title = new Date(n.ts).toLocaleString();
      top.appendChild(ts);
      item.appendChild(top);
      const sum = document.createElement("button");
      sum.className = "wn-sum";
      if (n.game?.away && n.game?.home) {
        sum.appendChild(scoreBoard(n.game));
        const caption = document.createElement("span");
        caption.className = "wn-match-caption";
        caption.textContent = n.game.away + " vs " + n.game.home;
        sum.appendChild(caption);
      }
      else sum.textContent = n.summary; // plain text only
      item.appendChild(sum);
      if (n.detail) {
        const det = document.createElement("div");
        det.className = "wn-det";
        det.textContent = n.detail;
        item.appendChild(det);
      }
      const open = sum;
      open.type = "button"; open.className = "wn-sum wn-item-link";
      open.setAttribute("aria-label", "Open notification: " + n.summary);
      open.disabled = !n.url && !findTabBySourceId(n.sourceId);
      open.onclick = (e) => {
        e.stopPropagation();
        n.seen = true; // App acknowledgement is separate from Gmail's unread state.
        if (n.service === "gmail") {
          const conn = connForSourceId(n.sourceId), itemId = notifItemKey(n);
          if (conn) {conn.openedMail ||= {}; conn.openedMail[itemId] = conn.baselineFp?.[itemId] || "";}
          store.notifications = store.notifications.filter(item=>!(item.service === "gmail" && item.sourceId === n.sourceId && notifItemKey(item) === itemId));
        }
        if(n.service === "github") {
          const conn=connForSourceId(n.sourceId);if(conn){conn.openedGithub ||= {};conn.openedGithub[notifItemKey(n)]=conn.baselineFp?.[notifItemKey(n)] || "";}
          store.notifications=store.notifications.filter(x=>x.id!==n.id);
        }
        broadcast(window); renderAll();
        openNotification(n);
      };
      const dis = document.createElement("button");
      dis.type = "button"; dis.className = "wn-btn wn-dismiss"; dis.title="Dismiss";
      dis.appendChild(wnIcon("close"));
      dis.setAttribute("aria-label", "Dismiss notification");
      dis.onclick = (e) => {
        e.stopPropagation();
        dismissNotification(n.id);
      };
      item.onclick = (e) => {if (!e.target.closest("button") && !open.disabled) open.click();};
      top.appendChild(dis);
      list.appendChild(item);
    }
  }

  function dismissNotification(id, quiet = false) {
    store.dismissIds[id] = Date.now();
    // Dismissing a game stops its title display until followed again.
    const n = store.notifications.find((x) => x.id === id);
    if (n && n.kind === "game" && n.game && n.game.key && store.followedGames[n.game.key]) {
      if (n.game.final) {
        // Final dismissed: clear title game so the name restores.
        if (store.titleGameKey === n.game.key) store.titleGameKey = "";
      } else {
        store.followedGames[n.game.key].dismissed = true;
        if (store.titleGameKey === n.game.key) store.titleGameKey = "";
      }
    }
    if (!quiet) { broadcast(window); renderAll(); }
  }

  function clearAllNotifications() {
    for (const n of store.notifications) {
      if (!store.dismissIds[n.id]) dismissNotification(n.id, true);
    }
    // Live ESPN/manual games render as live cards even without a notification
    // row; dismiss those too so Clear all truly empties the inbox.
    for (const [key, g] of Object.entries(store.followedGames)) {
      if (!g.dismissed && gameActive(g)) {
        g.dismissed = true;
        if (store.titleGameKey === key) store.titleGameKey = "";
      }
    }
    if (store.titleGameKey && store.followedGames[store.titleGameKey]?.dismissed) store.titleGameKey = "";
    broadcast(window); renderAll();
  }

  function openNotification(n) {
    hidePanels();
    const found = findTabBySourceId(n.sourceId);
    if (found) {
      try {
        found.win.gBrowser.selectedTab = found.tab;
        const conn = connForSourceId(n.sourceId);
        const actor = actorForBrowser(found.tab.linkedBrowser);
        if (actor && conn?.service === "gmail" && !n.url) actor.sendAsyncMessage("WorkspaceNotifications:OpenItem", { itemId: notifItemKey(n), summary:n.summary, url:"" });
        else if (n.url) found.win.openTrustedLinkIn(n.url, "current", {targetBrowser:found.tab.linkedBrowser, userContextId:conn?.containerId || 0});
        else if (conn?.url) found.win.openTrustedLinkIn(conn.url, "current", {targetBrowser:found.tab.linkedBrowser, userContextId:conn.containerId || 0});
      } catch (_e) {}
      try { if (found.win !== window) found.win.focus(); } catch (_e) {}
    } else if (n.url) {
      try {
        gBrowser.selectedTab = gBrowser.addTab(n.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      } catch (_e) {}
    }
  }

  function notifItemKey(n) {
    if (n.itemId) return n.itemId;
    // Reverse the "n-<sourceId>-<itemId>" scheme for OpenItem clicks.
    const p = "n-" + n.sourceId + "-";
    if (n.id.startsWith(p)) {
      const rest = n.id.slice(p.length).split("-r")[0];
      return rest;
    }
    if (n.game && n.game.key) return n.game.key;
    return "";
  }

  // ------------------------------------------------ sources panel

  function eligibleTabs() {
    const out = [];
    for (const w of allNormalWindows()) {
      let tabs = [];
      try { tabs = Array.from(w.gBrowser.tabs); } catch (_e) { continue; }
      for (const tab of tabs) {
        try {
          if (tab.hasAttribute("zen-essential") === false && tab.pinned === false) { /* ordinary ok */ }
          const url = tabUrl(tab);
          const svc = url ? isSupportedUrl(url) : null;
          // Include supported tabs plus tabs whose URL is unknown (pending) but label hints at service.
          let hinted = svc;
          if (!hinted && !url) {
            const hints = tabIdentity(tab).join(" ").toLowerCase();
            if (hints.includes("mail.google.com")) hinted = "gmail";
            else if (hints.includes("calendar.google.com")) hinted = "calendar";
            else if (hints.includes("github.com")) hinted = "github";
            else if (hints.includes("google.") && hints.includes("search")) hinted = "scores";
          }
          if (!hinted) continue;
          let boundId = "";
          try { boundId = SessionStore.getCustomTabValue(tab, TAB_VALUE_KEY) || ""; } catch (_e) {}
          out.push({
            win: w, tab, url: url || "(loading…)", service: hinted,
            title: (tab.label || tab.getAttribute("label") || url || "").slice(0, 80),
            pinned: !!tab.pinned, essential: tab.hasAttribute("zen-essential"),
            containerId: parseInt(tab.getAttribute("usercontextid") || "0", 10) || 0,
            unloaded: isTabPending(tab), boundId,
          });
        } catch (_e) {}
      }
    }
    return out;
  }

  function connectTab(entry) {
    const url = validHttpsUrl(entry.url) || entry.url;
    // Deduplicate duplicate connections to the same account/list or match.
    const identity=(service,value,container)=>{
      let scope=(value || '').split('#')[0];
      if(NATIVE_SERVICES.has(service))try{scope=new URL(value).origin;}catch(_e){}
      return service+'|'+scope+'|'+(container || 0);
    };
    const key=identity(entry.service,url,entry.containerId);
    const dupe=store.connections.find(c=>!c.ical && identity(c.service,c.url,c.containerId)===key);
    if (dupe) {
      if (dupe.paused) dupe.paused = false;
      activateOnTab(entry.win, entry.tab, dupe);
      broadcast(entry.win);
      renderAll();
      return dupe;
    }
    const id = "src-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const conn = {
      id, service: entry.service, url: (url || "").slice(0, 600),
      label: entry.title || entry.service, containerId: entry.containerId || 0,
      paused: false, bgRefresh: false, listKey: "", baseline: new Set(), baselineFp: {},
      lastScanTs: 0, lastOkTs: 0, status: "Monitoring", reminded: {},
    };
    store.connections.push(conn);
    activateOnTab(entry.win, entry.tab, conn);
    // Immediate scan after explicit connection (baseline establishes quietly).
    scanSource(conn.id);
    broadcast(window);
    renderAll();
    return conn;
  }

  // Tab-free calendar source: subscribe to an iCal feed URL (e.g. Google
  // Calendar's secret address). The coordinator polls it; no tab needed.
  function addICalConnection(rawUrl) {
    if (String(rawUrl).length>600) throw Error("The iCal URL is too long (maximum 600 characters)");
    const url = validHttpsUrl(rawUrl);
    if (!url) throw Error("Enter an https:// iCal URL");
    const dupe = store.connections.find((c) => c.service === "calendar" && c.ical && c.url === url);
    if (dupe) {
      if (dupe.paused) dupe.paused = false;
      broadcast(window);
      renderAll();
      return dupe;
    }
    const id = "src-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const conn = {
      id, service: "calendar", ical: true, url: url.slice(0, 600),
      label: "iCal feed", containerId: 0,
      paused: false, bgRefresh: false, listKey: "", baseline: new Set(), baselineFp: {},
      lastScanTs: 0, lastOkTs: 0, status: "", reminded: {},
    };
    store.connections.push(conn);
    broadcast(window);
    renderAll();
    return conn;
  }

  function scanSource(sourceId) {
    if (NATIVE_SERVICES.has(connForSourceId(sourceId)?.service)) { Sources?.sync(); renderAll(); return; }
    const conn = connForSourceId(sourceId);
    if (!conn || conn.paused) return;
    logEvent("scan requested", {sourceId, service: conn.service}, "info");
    const found = findTabBySourceId(sourceId);
    if (!found) {
      conn.status = "Tab unloaded";
      logEvent("source tab missing", {sourceId}, "error");
      conn.actorOk = false;
      renderAll();
      return;
    }
    if (isTabPending(found.tab)) {
      conn.status = "Tab unloaded — open the tab once, then Scan now";
      conn.actorOk = false;
      renderAll();
      // Opening the tab materializes its browser; activation follows via SSTabRestored.
      return;
    }
    ensureActivated(found.win, found.tab, conn);
    const ok = sendToActor(found.tab.linkedBrowser, "WorkspaceNotifications:ScanNow", { sourceId });
    conn.actorOk = ok;
    if (!ok) {
      conn.status = "Waiting for tab… — retrying, then Scan now again";
      renderAll();
      setTimeout(() => {
        try {
          const c = connForSourceId(sourceId);
          if (!c || c.paused) return;
          const f = findTabBySourceId(sourceId);
          if (!f || isTabPending(f.tab)) return;
          ensureActivated(f.win, f.tab, c);
          sendToActor(f.tab.linkedBrowser, "WorkspaceNotifications:ScanNow", { sourceId });
        } catch (_e) {}
      }, 1200);
    } else {
      conn.status = conn.hasScanned ? conn.status : "Waiting for first scan…";
      renderAll();
    }
  }

  function ensureActivated(win, tab, conn) {
    try {
      sendToActor(tab.linkedBrowser, "WorkspaceNotifications:Activate", { sourceId: conn.id, service: conn.service });
    } catch (_e) {}
    void win;
  }

  function reloadSource(sourceId) {
    const conn = connForSourceId(sourceId);
    if (!conn) return;
    const found = findTabBySourceId(sourceId);
    if (!found) { conn.status = "Tab unloaded"; renderAll(); return; }
    try {
      const browser = found.tab.linkedBrowser;
      if (!browser || browser.webProgress?.isLoadingDocument) return;
      browser.reload();
    } catch (_e) {}
  }

  function followTabAsGame(connId) {
    const conn = connForSourceId(connId);
    if (!conn || conn.service !== "scores") return;
    conn.followNextGame = true;
    scanSource(connId);
    renderAll();
  }

  function diagnosticsText() {
    const lines = [];
    try {
      lines.push("actor=WorkspaceNotifications safeForUntrustedWebProcess=true");
      lines.push("enabled=" + isEnabled());
      lines.push("windows=" + allNormalWindows().length);
      for (const c of store.connections) {
        lines.push(
          "[" + c.service + "] " + (c.label || c.id).slice(0, 60) +
          " status=" + (c.status || (c.hasScanned ? "Monitoring" : "waiting")) +
          " paused=" + !!c.paused + " actorOk=" + (c.actorOk !== false) +
          " hasScanned=" + !!c.hasScanned + " items=" + (c.lastCount | 0) +
          " meta=" + (c.lastMeta || "-") +
          " lastOk=" + (c.lastOkTs ? new Date(c.lastOkTs).toLocaleTimeString() : "-")
        );
      }
      lines.push("sources="+JSON.stringify(Sources?.diagnostics() || {}));
      lines.push("notifications=" + store.notifications.length + " games=" + Object.keys(store.followedGames).length + " title=" + (store.titleGameKey || "-"));
    } catch (e) {
      lines.push("diagnostics error: " + (e && e.message));
    }
    lines.push("Recent activity:", ...diagnosticEvents.slice(-12));
    return lines.join("\n");
  }

  function renderSourcesPanel() {
    if (!feedPanel) return;
    feedPanel.classList.add("wn-wide");
    const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls || "";if(text!=null)n.textContent=text;return n;};
    const button=(text,fn)=>{const b=el("button","wn-btn wn-small",text);b.type="button";b.onclick=e=>{e.stopPropagation();fn();};return b;};
    const nav=view=>{sourceView=view;sourceDetailId="";renderSourcesPanel();feedPanel.querySelector(".wn-main-title")?.focus();};
    const openDetail=id=>{sourceView='app';sourceDetailId=id;renderSourcesPanel();feedPanel.querySelector('.wn-main-title')?.focus();};
    const visit=(url,containerId=0)=>{if(validHttpsUrl(url)){gBrowser.selectedTab=gBrowser.addTab(url,{userContextId:containerId,triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});hidePanels();}};
    const toggle=(on,label,fn)=>{const b=button('',fn);b.setAttribute('role','switch');b.setAttribute('aria-checked',String(on));b.setAttribute('aria-label',label);b.classList.toggle('wn-on',on);return b;};
    const dot=on=>{const d=el('span','wn-dot'+(on?' on':''));d.setAttribute('aria-hidden','true');return d;};
    const chev=label=>{const b=el('button','wn-chev');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.appendChild(wnIcon('chev'));return b;};
    const appSub=c=>c.service==='gmail' ? (c.label?.match(/[\w.+-]+@[\w.-]+/)?.[0] || 'Account '+((c.url?.match(/\/u\/(\d+)/)?.[1] || '0')*1+1)) : c.service==='calendar' ? (c.ical ? 'iCal feed' : 'Google Calendar') : c.service==='github' ? 'Unread notification inbox' : (c.label || c.url);
    const setPaused=(c,paused)=>{c.paused=paused;const f=findTabBySourceId(c.id);if(f){if(paused)deactivateOnTab(f.tab,c.id,false);else activateOnTab(f.win,f.tab,c);}broadcast(window);renderAll();};
    const disconnect=c=>{const f=findTabBySourceId(c.id);if(f)deactivateOnTab(f.tab,c.id);store.connections=store.connections.filter(x=>x.id!==c.id);store.notifications=store.notifications.filter(n=>n.sourceId!==c.id);for(const [key,g]of Object.entries(store.followedGames))if(g.sourceId===c.id)delete store.followedGames[key];broadcast(window);renderAll();};
    const openConn=c=>{const f=findTabBySourceId(c.id);if(f){f.win.gBrowser.selectedTab=f.tab;if(c.service==='github')f.win.openTrustedLinkIn('https://github.com/notifications?query=is%3Aunread','current',{targetBrowser:f.tab.linkedBrowser,userContextId:c.containerId || 0});f.win.focus();hidePanels();}else{visit(c.url,c.containerId);activateOnTab(window,gBrowser.selectedTab,c);}};
    const appCard=c=>{
      const card=el('div','wn-app-card');card.setAttribute('data-wn-key',c.id);
      const iconWrap=el('span','wn-app-iconwrap');iconWrap.appendChild(appIcon(c));card.appendChild(iconWrap);
      const meta=el('div','wn-app-meta');
      meta.append(el('div','wn-app-name',SERVICE_LABEL[c.service] || c.service));
      meta.append(el('div','wn-app-sub',appSub(c)));
      const st=el('div','wn-app-status');st.append(dot(!c.paused && connStatusText(c).startsWith('Monitoring') || (!c.paused && c.hasScanned && c.status==='Monitoring')));
      const stText=el('span','',connStatusText(c));stText.title=connStatusText(c);st.append(stText);meta.append(st);
      card.append(meta);
      card.append(toggle(!c.paused,'Monitor '+(SERVICE_LABEL[c.service] || c.service),()=>setPaused(c,!c.paused)));
      const go=chev('Options for '+(SERVICE_LABEL[c.service] || c.service));go.setAttribute('data-wn-key','chev-'+c.id);go.onclick=e=>{e.stopPropagation();openDetail(c.id);};card.append(go);
      return card;
    };
    const teamNext=t=>{
      const games=(t.schedule || []).filter(g=>g.state==='in' || (g.state==='pre' && g.startTs>=Date.now()-3600000)).sort((a,b)=>Number(b.state==='in')-Number(a.state==='in') || a.startTs-b.startTs);
      return games[0] || null;
    };
    const iconBtn=(icon,label,fn)=>{const b=el('button','wn-icon-btn');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.appendChild(wnIcon(icon));b.onclick=e=>{e.stopPropagation();fn();};return b;};
    const teamCard=(key,t)=>{
      const card=el('div','wn-app-card wn-has-corner');card.setAttribute('data-wn-key',key);
      const img=el('img','wn-team-logo-img');img.src=teamIconUrl(t.logo);img.alt='';img.onerror=()=>{img.hidden=true;};card.append(img);
      const meta=el('div','wn-app-meta');
      meta.append(el('div','wn-app-name',t.name));
      const g=teamNext(t);
      meta.append(el('div','wn-app-sub',t.league.toUpperCase()));
      const st=el('div','wn-app-status');
      if(g){const sTxt=el('span','',g.state==='in'?g.status:g.away+' vs '+g.home+' · '+new Date(g.startTs).toLocaleString());sTxt.title=sTxt.textContent;st.append(dot(g.state==='in'),sTxt);}
      else if(t.paused)st.append(dot(false),el('span','','Paused'));
      else if(t.status!=='Monitoring')st.append(dot(false),el('span','',t.status));
      else st.append(dot(false),el('span','','No upcoming game scheduled'));
      meta.append(st);card.append(meta);
      card.append(toggle(!t.paused,'Monitor '+t.name,()=>{t.paused=!t.paused;Sources.refresh(t.league);broadcast(window);renderAll();}));
      const corner=el('div','wn-card-corner');
      corner.append(iconBtn('open','Open '+t.name+' team page',()=>visit(t.url)));
      const unf=iconBtn('check','Following — click to unfollow '+t.name,()=>unfollowTeam(key));unf.classList.add('wn-is-on');corner.append(unf);
      card.append(corner);
      return card;
    };

    const wrap=el("div","wn-wrap"),shell=el("div","wn-source-shell");
    // Icon-only sidebar rail.
    const side=el("nav","wn-side");side.setAttribute("aria-label","Sources");
    const railParent={inbox:'inbox',apps:'apps',gmail:'apps',github:'apps',calendar:'apps',scores:'apps',slack:'apps',msteams:'apps',discord:'apps',outlook:'apps',teams:'teams',settings:'settings',app:'apps'}[sourceView] || 'inbox';
    for(const [view,icon,label] of [['inbox','inbox','Inbox'],['apps','apps','Apps'],['teams','teams','Teams'],['settings','settings','Settings']]){
      const b=el('button','wn-side-btn'+(railParent===view?' wn-on':''));
      b.type='button';b.title=label;b.setAttribute('aria-label',label);b.setAttribute('data-wn-key','side-'+view);
      b.appendChild(wnIcon(icon));
      if(railParent===view)b.setAttribute('aria-current','page');
      b.onclick=e=>{e.stopPropagation();nav(view);};side.append(b);
    }
    const spacer=el('div','wn-side-spacer');side.append(spacer);
    const add=el('button','wn-side-btn wn-side-add');add.type='button';add.title='Add source';add.setAttribute('aria-label','Add source');add.setAttribute('data-wn-key','side-add');add.appendChild(wnIcon('plus'));add.onclick=e=>{e.stopPropagation();nav('apps');};side.append(add);
    shell.append(side);

    const main=el('div','wn-main');
    const top=el('div','wn-main-top');
    const titleRow=el('div','wn-main-titlerow');
    const titles={inbox:['Inbox','Your notifications, newest first.'],apps:['Apps','Connect an app to get its notifications.'],teams:['Teams','Follow teams to track their games automatically.'],settings:['Settings','Reload, diagnostics and advanced options.'],gmail:['Mail','Choose a signed-in tab. Its account and container stay separate.'],github:['GitHub','Choose a signed-in GitHub tab to monitor its unread notification inbox.'],calendar:['Calendar','Only reminders that fire as desktop notifications appear.'],scores:['Scores tab','Choose a Google Search tab showing a live score.'],app:['Source','Source options.']};
    const pickerApp=NativeApps[sourceView==='msteams'?'teams':sourceView];
    const [ttl,sub]=titles[sourceView] || (pickerApp ? [pickerApp.label,'Connect a signed-in tab to capture future desktop alerts.'] : titles.inbox);
    const head=el('div','wn-main-head');const heading=el('h1','wn-main-title',ttl);heading.tabIndex=-1;head.append(heading,el('p','wn-main-sub',sub));titleRow.append(head);
    const close=el('button','wn-main-close');close.type='button';close.title='Close';close.setAttribute('aria-label','Close panel');close.setAttribute('data-wn-key','wn-close');close.appendChild(wnIcon('close'));close.onclick=e=>{e.stopPropagation();hidePanels();};titleRow.append(close);
    top.append(titleRow);main.append(top);
    const content=el('div','wn-main-scroll');main.append(content);shell.append(main);wrap.append(shell);

    const section=(text,link)=>{const h=el('div','wn-section-row');h.append(el('h2','wn-section-label',text));if(link)h.append(link);content.append(h);};
    const back=(label,view)=>{const b=el('button','wn-btn wn-small wn-back');b.type='button';b.setAttribute('data-wn-key','back-'+view);b.appendChild(wnIcon('back'));b.appendChild(document.createTextNode('Back'));b.setAttribute('aria-label','Back to '+label);b.onclick=e=>{e.stopPropagation();nav(view);};content.append(b);};

    if(sourceView==='inbox'){
      const undism = store.notifications.filter((n) => !store.dismissIds[n.id] && (n.service !== "gmail" || n.mailVerified) && (n.service !== "github" || n.githubVerified));
      const hasLive = Object.values(store.followedGames).some(g=>!g.dismissed && gameActive(g));
      if (undism.length || hasLive) {
        const actions=el('div','wn-inbox-actions');
        const clear=button('Clear all',()=>{clearAllNotifications();});
        clear.setAttribute('data-wn-key','clear-all');
        clear.setAttribute('aria-label','Dismiss all notifications');
        actions.append(clear);
        content.append(actions);
      }
      const list=el('div','wn-list');
      buildFeedList(list, undism);
      content.append(list);
    } else if(sourceView==='apps'){
      section('Add a source');
      const counts=s=>store.connections.filter(c=>c.service===s).length;
      const plats=[['gmail','Mail','Signed-in Gmail tabs',counts('gmail')],['github','GitHub','Unread notification inbox',counts('github')],['calendar','Calendar','Desktop reminders that fire',counts('calendar')],...Object.entries(NativeApps).filter(([key])=>key!=='calendar').map(([key,app])=>[key==='teams'?'msteams':key,app.label,'Desktop notifications',counts(key)]),['scores','Scores tab','Google Search live scores',counts('scores')],['teams','Sports team','Auto-tracked ESPN games',Object.keys(store.followedTeams).length]];
      for(const [view,label,desc,n]of plats){
        const card=el('button','wn-app-card wn-platform');card.setAttribute('data-wn-key','plat-'+view);
        card.setAttribute('aria-label','Connect '+label);
        const tile=el('span','wn-platform-tile');const entry=view==='teams'?null:NativeApps[view==='msteams'?'teams':view] || ({gmail:{url:'https://mail.google.com'},github:{url:'https://github.com'}})[view];if(entry)tile.append(appIcon({url:entry.url}));else tile.append(wnIcon('teams'));card.append(tile);
        const meta=el('div','wn-app-meta');meta.append(el('div','wn-app-name',label),el('div','wn-app-sub',desc+(n?' · '+n+' connected':'')));card.append(meta);
        const pchev=el('span','wn-chev-static');pchev.appendChild(wnIcon('chev'));card.append(pchev);
        card.onclick=()=>{if(view==='teams'){nav('teams');loadTeamPicker();}else nav(view);};
        content.append(card);
      }
      content.append(el('p','wn-hint','Mail and GitHub mirror unread inboxes. Other apps capture desktop alerts from your connected site and container.'));
      section('Connected apps');
      if(!store.connections.length)content.append(el('p','wn-hint','Nothing connected yet.'));
      for(const c of store.connections)content.append(appCard(c));
      const manage=button('Manage',()=>nav('teams'));manage.classList.add('wn-link-btn');manage.appendChild(wnIcon('chev'));
      section('Followed teams',manage);
      const teamEntries=Object.entries(store.followedTeams);
      if(!teamEntries.length)content.append(el('p','wn-hint','Follow a team to automatically track its future games.'));
      for(const [key,t]of teamEntries)content.append(teamCard(key,t));
    } else if(['gmail','github','calendar','scores','slack','msteams','discord','outlook'].includes(sourceView)){
      const pickerService=sourceView==='msteams'?'teams':sourceView;
      back('Apps','apps');
      if(sourceView==='calendar')content.append(el('p','wn-hint','In Google Calendar settings turn on desktop notifications and allow them for calendar.google.com in Zen. Only reminders that actually fire can appear — past and upcoming events are not listed.'));
      if(sourceView==='scores')content.append(el('p','wn-hint','Choose a Google Search tab showing a live score.'));
      if(NATIVE_SERVICES.has(pickerService))content.append(el("p","wn-hint","Enable desktop notifications in the app and allow them in Zen. Future alerts appear here while the app is running; earlier messages are not imported."));
      const tabs=eligibleTabs().filter(e=>e.service===pickerService && (!e.boundId || !connForSourceId(e.boundId)));
      if(!tabs.length){content.append(el('p','wn-empty','No unconnected tabs for this app. Open it, sign in, then return here.'));const app=NativeApps[pickerService];if(app)content.append(button('Open '+app.label,()=>visit(app.url)));}
      content.append(button('Refresh tabs',()=>renderSourcesPanel()));
      tabs.forEach((en,i)=>{const row=el('div','wn-source-row');row.setAttribute('data-wn-key','picker-'+i+'-'+en.containerId);row.append(el('div','wn-source-info',en.title),button('Connect',()=>{connectTab(en);nav('inbox');}));content.append(row);});
      if(sourceView==='calendar'){
        section('Subscribe to an iCal feed');
        content.append(el('p','wn-hint','Paste a calendar iCal URL (Google Calendar Settings → Integrate calendar → Secret address in iCal format). Timed events starting within 30 minutes — plus ongoing ones — appear automatically. No tab needed.'));
        const row=el('div','wn-ical-row');row.setAttribute('data-wn-key','ical-add');
        const input=el('input','wn-search');input.setAttribute('data-wn-key','ical-url');input.placeholder='https://calendar.google.com/calendar/ical/…/basic.ics';input.setAttribute('aria-label','iCal feed URL');input.setAttribute('inputmode','url');input.value=icalUrl;input.oninput=e=>{icalUrl=e.currentTarget.value;icalError='';};
        const addBtn=button('Subscribe',()=>{
          try{addICalConnection(feedPanel.querySelector('[data-wn-key="ical-url"]')?.value || '');icalUrl='';icalError='';nav('inbox');}
          catch(e){icalError=e.message;renderSourcesPanel();}
        });
        row.append(input,addBtn);content.append(row);
        if(icalError)content.append(el('div','wn-ical-error',icalError));
      }
    } else if(sourceView==='teams'){
      const leagues=el('div','wn-leagues');leagues.setAttribute('role','group');leagues.setAttribute('aria-label','League');
      for(const league of ['nfl','nba','mlb','nhl']){const b=button(league.toUpperCase(),()=>{if(pickerLeague===league)return;pickerLeague=league;pickerTeams=[];loadTeamPicker();});b.setAttribute('aria-pressed',String(pickerLeague===league));b.setAttribute('data-wn-key','league-'+league);b.classList.toggle('wn-on',pickerLeague===league);leagues.append(b);}content.append(leagues);
      const input=el('input','wn-search');input.setAttribute('data-wn-key','team-query');input.placeholder='Search teams';input.setAttribute('aria-label','Search teams');input.value=pickerQuery;input.oninput=e=>{pickerQuery=e.currentTarget.value;renderSourcesPanel();};content.append(input);
      content.append(el('div','wn-source-status',pickerStatus));
      if(pickerStatus.startsWith('Unavailable'))content.append(button('Retry',()=>loadTeamPicker()));
      const results=el('div','wn-team-results');results.setAttribute('data-wn-key','team-results');
      for(const t of pickerTeams.filter(t=>(t.name+' '+t.abbreviation).toLowerCase().includes(pickerQuery.toLowerCase()))){const row=el('div','wn-source-row');row.setAttribute('data-wn-key','pick-'+t.id);const img=el('img','wn-source-logo');img.src=teamIconUrl(t.logo);img.alt='';img.onerror=()=>img.hidden=true;const followed=!!store.followedTeams['espn:'+t.league+':'+t.id];const follow=iconBtn(followed?'check':'plus',followed?'Following '+t.name:'Follow '+t.name,()=>{followTeam(t);renderSourcesPanel();});if(followed){follow.disabled=true;follow.classList.add('wn-is-on');}row.append(img,el('div','wn-source-info',t.name),follow);results.append(row);}content.append(results);
      if(!pickerStatus && !results.childNodes.length)content.append(el('p','wn-hint','No teams match your search.'));
      section('Followed teams');
      if(!Object.keys(store.followedTeams).length)content.append(el('p','wn-hint','Nothing followed yet.'));
      for(const [key,t]of Object.entries(store.followedTeams))content.append(teamCard(key,t));
    } else if(sourceView==='app'){
      back('Apps','apps');
      const c=connForSourceId(sourceDetailId);
      if(!c){content.append(el('p','wn-hint','This source no longer exists.'));}
      else{
        const hero=el('div','wn-detail-hero');hero.setAttribute('data-wn-key','hero-'+c.id);
        const iconWrap=el('span','wn-app-iconwrap wn-large');iconWrap.appendChild(appIcon(c));hero.append(iconWrap);
        const meta=el('div','wn-app-meta');
        meta.append(el('div','wn-app-name',SERVICE_LABEL[c.service] || c.service));
        meta.append(el('div','wn-app-sub',appSub(c)));
        const st=el('div','wn-app-status');st.append(dot(!c.paused));const sTxt=el('span','',connStatusText(c));sTxt.title=connStatusText(c);st.append(sTxt);meta.append(st);
        hero.append(meta);content.append(hero);
        content.append(toggle(!c.paused,'Monitor '+(SERVICE_LABEL[c.service] || c.service),()=>setPaused(c,!c.paused)));
        const acts=el('div','wn-detail-actions');
        if(!c.ical)acts.append(button('Open',()=>openConn(c)));
        if(NATIVE_SERVICES.has(c.service) && !c.ical)acts.append(button(c.service==='calendar'?'Send test reminder':'Send test alert',()=>{try { Sources?.sendTestReminder?.(c.id); } catch (_e) {} renderAll();}));
        else if(c.service==='scores')acts.append(button('Scan and follow game',()=>followTabAsGame(c.id)));
        else if(c.ical)acts.append(button('Poll now',()=>{try { Sources?.pollNow?.(c.id); } catch (_e) {} renderAll();}));
        else acts.append(button('Refresh',()=>scanSource(c.id)));
        acts.append(button('Disconnect',()=>{disconnect(c);nav('inbox');}));
        content.append(acts);
        if(c.containerId)content.append(el('div','wn-detail-line','Container '+c.containerId));
        if(c.url)content.append(el('div','wn-detail-line',c.url));
        if(c.service==='scores'){
          for(const [key,g] of Object.entries(store.followedGames).filter(([,g])=>g.sourceId===c.id)){
            const match=el('div','wn-score-card');match.setAttribute('data-wn-key',key);const actions=el('div','wn-score-actions');match.append(el('span','wn-score-status',g.status || 'Game'),scoreBoard(g),el('span','wn-match-caption',g.away+' vs '+g.home));actions.append(button(g.dismissed?'Follow':'Unfollow',()=>{g.dismissed=!g.dismissed;broadcast(window);renderAll();}),button('Show in workspace',()=>{g.dismissed=false;g.showInTitle=true;g.pinFinal=/final/i.test(g.status);store.titleGameKey=key;broadcast(window);renderAll();}));match.append(actions);content.append(match);
          }
        }
      }
    } else if(sourceView==='settings'){
      section('Tab reload settings');
      for(const c of store.connections.filter(c=>!NATIVE_SERVICES.has(c.service))){const row=el('div','wn-source-row');row.setAttribute('data-wn-key','settings-'+c.id);row.append(el('div','wn-source-info',c.label || SERVICE_LABEL[c.service]),button('Reload',()=>reloadSource(c.id)),toggle(c.bgRefresh,'Auto-reload '+c.label,()=>{c.bgRefresh=!c.bgRefresh;broadcast(window);renderAll();}));content.append(row);}
      section('Diagnostics');content.append(el('pre','wn-diag',diagnosticsText()));
      content.append(button('Copy diagnostics',()=>{Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(diagnosticsText());}),button('Refresh all',()=>{for(const c of store.connections)scanSource(c.id);for(const t of Object.values(store.followedTeams))Sources.refresh(t.league);Sources.sync();}));
    }
    commitPanel(wrap,'sources:'+sourceView+(sourceView==='app' ? ':'+sourceDetailId : ''));
  }
  async function loadTeamPicker() {
    const generation=++pickerGeneration,league=pickerLeague;pickerStatus='Loading teams\u2026';renderSourcesPanel();
    try{const teams=await Sources.teams(league);if(generation!==pickerGeneration)return;pickerTeams=teams;pickerStatus=teams.length?'':'Unavailable - no team directory returned';}
    catch(e){if(generation!==pickerGeneration)return;pickerStatus='Unavailable - '+e.message;}
    if(sourceView==='teams')renderSourcesPanel();
  }

  let renderedView = "";

  // Reconcile the same controls in place. Native hover, pressed state, focus,
  // text selection and scrolling stay owned by the browser.
  function reconcileChildren(current, fresh) {
    const oldNodes = Array.from(current.childNodes);
    const key = (node, index) => node.nodeType === 1
      ? (node.getAttribute("data-wn-key") || node.localName + ":" + index)
      : "text:" + index;
    const oldByKey = new Map(oldNodes.map((node, i) => [key(node, i), node]));
    const retained = new Set();
    let index = 0;
    for (const incoming of Array.from(fresh.childNodes)) {
      const existing = oldByKey.get(key(incoming, index));
      let node = incoming;
      if (existing && existing.nodeType === incoming.nodeType && existing.localName === incoming.localName) {
        node = existing;
        if (node.nodeType === 1) {
          for (const attr of Array.from(node.attributes)) {
            if (attr.name === "open" || attr.name === "value") continue;
            if (!incoming.hasAttribute(attr.name)) node.removeAttribute(attr.name);
          }
          for (const attr of Array.from(incoming.attributes)) {
            if (attr.name === "open" || attr.name === "value") continue;
            if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
          }
          node.onclick = incoming.onclick;
          node.onkeydown = incoming.onkeydown;
          node.oninput = incoming.oninput; node.onchange = incoming.onchange; node.onerror=incoming.onerror;
          if (!["input","select"].includes(node.localName)) reconcileChildren(node, incoming);
        } else if (node.data !== incoming.data) node.data = incoming.data;
      }
      retained.add(node);
      const atIndex = current.childNodes[index];
      if (atIndex !== node) current.insertBefore(node, atIndex || null);
      index++;
    }
    for (const node of oldNodes) if (!retained.has(node) && node.parentNode === current) node.remove();
  }

  function commitPanel(fresh, view) {
    const current = feedPanel.querySelector(".wn-wrap");
    if (renderedView !== view) {
      current.replaceChildren(...Array.from(fresh.childNodes));
      current.scrollTop = 0;
      renderedView = view;
    } else reconcileChildren(current, fresh);
  }

  function renderAll() {
    paintOverlay();
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      if (!isFeedOpen()) return;
      renderSourcesPanel();
    }, 80);
  }

  function noteInteraction() { lastInteraction = Date.now(); }

  function refreshIntervalMs() {
    const m = getPref("refresh-interval-min", 2);
    return Math.max(MIN_REFRESH_MS, clamp((+m || 2) * 60 * 1000, MIN_REFRESH_MS, 24 * 60 * 60 * 1000));
  }

  function isRefreshEligible(tab, browser) {
    try {
      if (!tab || !browser) return false;
      if (isTabPending(tab)) return false; // do not wake discarded tabs
      if (gBrowser.selectedTab === tab) return false; // inactive tabs only
      if (browser.webProgress && browser.webProgress.isLoadingDocument) return false;
      if (tab.soundPlaying || tab.hasAttribute("soundplaying")) return false;
      if (Date.now() - lastInteraction < 60 * 1000) return false;
      // Skip tabs with unsaved form input / editable content / open dialogs.
      try {
        const doc = browser.contentDocument;
        if (doc) {
          if (doc.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return false;
          if (doc.querySelector("input:focus, textarea:focus, [contenteditable='true']:focus")) return false;
          const dirty = doc.querySelector("input:not([type='hidden']), textarea");
          if (dirty && dirty.value && dirty.value.length > 0 && doc.hasFocus && !doc.hasFocus()) {
            // Conservative: any non-empty field blocks auto reload.
            return false;
          }
          if (doc.querySelector("[contenteditable='true']")) {
            const ed = doc.querySelector("[contenteditable='true']");
            if (ed && (ed.textContent || "").trim().length > 0) return false;
          }
        }
      } catch (_e) { /* cross-origin: fall through to allow */ }
      return true;
    } catch (_e) { return false; }
  }

  function backgroundTick() {
    if (!isEnabled() || isPrivateWindow(window)) return;
    try {
      const active = Services.wm.getMostRecentWindow("navigator:browser");
      if (active !== window) return; // one window drives refresh
    } catch (_e) {}
    const interval = refreshIntervalMs();
    const now = Date.now();
    for (const conn of store.connections) {
      if (!conn.bgRefresh || conn.paused || NATIVE_SERVICES.has(conn.service)) continue;
      if (now - (conn._lastRefresh || 0) < interval) continue;
      const found = findTabBySourceId(conn.id);
      if (!found) continue;
      if (found.win !== window) continue; // owning window refreshes
      if (!isRefreshEligible(found.tab, found.tab.linkedBrowser)) continue;
      conn._lastRefresh = now;
      try { found.tab.linkedBrowser.reload(); } catch (_e) {}
      dlog("background refresh", conn.id);
    }
  }

  // ------------------------------------------------ events / init

  function onObs(_subject, topic, data) {
    if (topic !== OBS_TOPIC) return;
    try {
      // Ignore our own broadcast echo when seq matches.
      const d = JSON.parse(data);
      if (d && d.seq === store.seq) return;
    } catch (_e) {}
    applyRemote(data);
  }

  function watchWorkspaces() {
    window.addEventListener("ZenWorkspacesUIUpdate", () => {
      setTimeout(() => { ensureTitleBound(); renderAll(); }, 60);
    });
    try {
      if (window.gZenWorkspaces && window.gZenWorkspaces.promiseInitialized) {
        window.gZenWorkspaces.promiseInitialized.then(() => {
          ensureTitleBound(); rebindAllTabs(); renderAll();
        }).catch(() => {});
      }
    } catch (_e) {}
    window.addEventListener("SSTabRestored", (e) => {
      try {
        const tab = e.target;
        const id = SessionStore.getCustomTabValue(tab, TAB_VALUE_KEY);
        if (!id) return;
        const conn = connForSourceId(id);
        if (conn && !conn.paused && !isTabPending(tab)) activateOnTab(window, tab, conn);
      } catch (_e) {}
    });
    if (gBrowser && gBrowser.tabContainer) {
      gBrowser.tabContainer.addEventListener("TabOpen", () => setTimeout(renderAll, 200));
      gBrowser.tabContainer.addEventListener("TabClose", () => setTimeout(renderAll, 200));
      gBrowser.tabContainer.addEventListener("TabAttrModified", () => {});
    }
    // Load scans: after completed loads re-activate the actor (it only
    // exists once the content process has a live document) and request a scan.
    try {
      const mm = gBrowser && gBrowser.tabContainer;
      if (mm) {
        mm.addEventListener("SSTabRestored", () => setTimeout(rebindAllTabs, 300));
      }
    } catch (_e) {}
    if (gBrowser) {
      gBrowser.addTabsProgressListener({
        onStateChange(_browser, _webProgress, _request, _flags, _status) {},
        onLocationChange(browser) {
          try {
            if (!browser || !browser.ownerDocument) return;
            const tab = gBrowser.getTabForBrowser(browser);
            if (!tab) return;
            let id = "";
            try { id = SessionStore.getCustomTabValue(tab, TAB_VALUE_KEY) || ""; } catch (_ee) {}
            if (!id) return;
            const conn = connForSourceId(id);
            if (!conn || conn.paused) return;
            setTimeout(() => {
              try {
                if (tab.closing || isTabPending(tab)) return;
                activateOnTab(window, tab, conn);
              } catch (_ee) {}
            }, 700);
          } catch (_ee) {}
        },
      });
    }
    window.addEventListener("mousemove", noteInteraction, true);
    window.addEventListener("keydown", noteInteraction, true);
  }

  function ingestListWrapped(conn, items, account, isFirst) { return ingestList(conn,items,account,isFirst); }

  function init() {
    if (!window.gBrowser) { setTimeout(init, 200); return; }
    if (isPrivateWindow(window)) return; // private windows neither collect nor display
    ensureActorRegistered();
    ({compareNotifications,notificationTime}=ChromeUtils.importESModule("resource://workspace-notifications/NotificationData.sys.mjs"));
    ({NATIVE_APPS:NativeApps,nativeServiceForURL}=ChromeUtils.importESModule("resource://workspace-notifications/NotificationApps.sys.mjs"));
    ({Sources}=ChromeUtils.importESModule("resource://workspace-notifications/NotificationSources.sys.mjs"));
    detachSources=Sources.attach({window,getState:()=>({...store,enabled:isEnabled()}),onEvent:handleSourceEvent});
    loadStore();
    ensurePanels();
    ensureTitleBound();
    watchWorkspaces();
    try { Services.obs.addObserver(onObs, OBS_TOPIC); } catch (_e) {}
    window.addEventListener("unload", () => {
      detachSources?.();
      try { Services.obs.removeObserver(onObs, OBS_TOPIC); } catch (_e) {}
      try { if (saveTimer) clearTimeout(saveTimer); } catch (_e) {}
      if (renderTimer) clearTimeout(renderTimer);
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
        try { IOUtils.writeUTF8(storeFilePath(), JSON.stringify(serialize())); } catch (_e) {}
    });
    // Rebind after session restore settles.
    const later = () => { setTimeout(() => { ensureTitleBound(); rebindAllTabs(); renderAll(); }, 1200); };
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later, { once: true });
    // Reminder + refresh drivers.
    setInterval(()=>Sources?.sync(),30000);
    setInterval(backgroundTick, 60 * 1000);

    // Title rebind loop (cheap): covers workspace creation/session restore races.
    setInterval(() => { ensureTitleBound(); }, 5000);
    logEvent("initialized", {version: "1.9.0", connections: store.connections.length}, "info");
  }

  window.WorkspaceNotifications = {
    openFeed: () => openFeedPanel(null, true),
    openSources: () => openSourcesPanel(),
    scan: (id) => scanSource(id),
    scanAll: () => { for (const cc of store.connections) scanSource(cc.id); },
    followTabAsGame: (id) => followTabAsGame(id),
    followTeam, unfollowTeam,
    unpin: () => unpinFromIndicator(),
    clearAll: () => clearAllNotifications(),
    providerStatus:()=>Sources?.diagnostics(),
    state: () => ({ followedTeams:Object.keys(store.followedTeams).length, calendarCapture:Sources?.calendarStatus(), connections: store.connections.length, notifications: store.notifications.length, games: Object.keys(store.followedGames).length }),
    diagnostics: () => diagnosticsText(),
    logs: () => diagnosticEvents.slice(),
    debug: () => {
      // Always prints (not gated on the debug pref) so users can verify
      // the mod is loaded. Run in the Browser Console (Ctrl+Shift+J).
      console.log("[WorkspaceNotifications] " + diagnosticsText());
      for (const cc of store.connections) scanSource(cc.id);
      return diagnosticsText();
    },
    store,
  };

  if (document.readyState === "complete") init();
  else window.addEventListener("DOMContentLoaded", init);
})();
