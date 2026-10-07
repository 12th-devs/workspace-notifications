import {LEAGUES, parseTeams, parseGames, teamKey, parseICS} from './NotificationData.sys.mjs';
import {NATIVE_APPS, matchesNativeSource} from './NotificationApps.sys.mjs';

const ICAL_POLL_MS = 5 * 60 * 1000;
const ICAL_LEAD_MIN = 30;
const ICAL_BACKOFF_CAP = 15 * 60 * 1000;

function icalDetail(e) {
  const time = (ts) => new Date(ts).toLocaleString(undefined, {hour: 'numeric', minute: '2-digit'});
  const day = (ts) => new Date(ts).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  const sameDay = new Date(e.startTs).toDateString() === new Date().toDateString();
  const range = sameDay ? `${time(e.startTs)} – ${time(e.endTs)}` : `${day(e.startTs)} – ${time(e.endTs)}`;
  return e.location ? `${range} · ${e.location}` : range;
}

// One module instance in the parent process owns all polling and observers.
export class SourceCoordinator {
  clients = new Set(); requests = new Map(); cache = new Map(); failures = new Map();
  schedules = new Map(); scoreboardDue = new Map(); emitted = new Map();
  activeAlerts = new Map();
  ical = new Map(); // connId -> {due, count, keys:Map(key->event)}
  timer = null; owner = null; busy = false; capture = false; previousPref = null;
  // Capture telemetry: every web notification seen while observing is counted,
  // so the UI can tell "nothing fires anywhere" apart from "fires, but the
  // Calendar tab/permission/container does not match".
  seenAlerts = 0; lastAlertAt = 0; lastAlertOrigin = '';
  constructor() { this.observe = this.observe.bind(this); }
  attach(client) {
    this.clients.add(client);
    if (!this.owner) this.start(client);
    this.sync();
    return () => {
      this.clients.delete(client);
      if (this.owner === client) {
        client.window.clearInterval(this.timer); this.timer=null; this.owner=null;
        const next=this.clients.values().next().value; if (next) this.start(next);
      }
      this.sync();
    };
  }
  start(client) { this.owner=client; this.timer=client.window.setInterval(()=>this.tick(),10000); }
  emit(event) { this.owner?.onEvent(event); }
  state() { return this.owner?.getState() || {connections:[],followedTeams:{}}; }
  sync() {
    for (const [key,event] of this.activeAlerts) {
      if (!this.state().enabled || !this.state().connections.some(c=>c.id===event.sourceId && !c.paused)) {
        this.activeAlerts.delete(key);this.emit({...event,closed:true});
      }
    }
    for (const id of [...this.ical.keys()]) {
      if (!this.state().enabled || !(this.state().connections || []).some(c=>c.id===id && c.service==='calendar' && c.ical && !c.paused)) {
        this.closeICal(id);
      }
    }
    const wanted=this.state().connections.some(c=>NATIVE_APPS[c.service] && !c.ical && !c.paused) && this.state().enabled;
    if (wanted && !this.capture) {
      const p=Services.prefs, pref='browser.alerts.capture.enabled';
      if (p.getPrefType(pref) !== p.PREF_BOOL) { void this.tick(); return; }
      let prevVal=true;
      try { prevVal=p.getBoolPref(pref); } catch (_e) {}
      this.previousPref={user:p.prefHasUserValue(pref), value:prevVal};
      p.setBoolPref(pref,true);
      Services.obs.addObserver(this.observe,'web-notification-shown');
      Services.obs.addObserver(this.observe,'web-notification-closed'); this.capture=true;
    } else if (!wanted && this.capture) {
      Services.obs.removeObserver(this.observe,'web-notification-shown'); Services.obs.removeObserver(this.observe,'web-notification-closed');
      const p=Services.prefs, pref='browser.alerts.capture.enabled';
      if (!this.prefChanged && p.getBoolPref(pref,false) === true) {
        if (this.previousPref.user) p.setBoolPref(pref,this.previousPref.value); else p.clearUserPref(pref);
      }
      p.removeObserver(pref,this.prefObserver); this.capture=false; this.previousPref=null; this.prefChanged=false;
    }
    if (this.capture && !this.prefObserver) {
      this.prefObserver={observe:()=>{this.prefChanged=true;}};
      Services.prefs.addObserver('browser.alerts.capture.enabled',this.prefObserver);
    }
    // Reattach preference monitoring on a later activation.
    if (!this.capture) this.prefObserver=null;
    void this.tick();
  }
  calendarStatus() {
    if (Services.prefs.getPrefType('browser.alerts.capture.enabled') !== Services.prefs.PREF_BOOL) return 'Native reminder capture unavailable in this Zen build';
    return this.capture && Services.prefs.getBoolPref('browser.alerts.capture.enabled',false) ? 'Waiting for Google reminders' : 'Reminder capture disabled';
  }
  nativeStatus() {
    if (Services.prefs.getPrefType('browser.alerts.capture.enabled') !== Services.prefs.PREF_BOOL) return 'Desktop alert capture unavailable in this Zen build';
    return this.capture && Services.prefs.getBoolPref('browser.alerts.capture.enabled',false) ? 'Monitoring desktop alerts' : 'Desktop alert capture disabled';
  }
  observe(subject,topic) {
    try {
      const a=subject.QueryInterface(Ci.nsIAlertNotification), p=a.principal;
      this.seenAlerts++; this.lastAlertAt=Date.now();
      try { this.lastAlertOrigin=String(p?.URI?.prePath || p?.origin || ''); } catch (_e) {}
      if (!this.state().enabled || !p || a.inPrivateBrowsing || p.originAttributes.privateBrowsingId) return;
      const source=this.state().connections.find(c=>matchesNativeSource(c,p.URI?.prePath,p.originAttributes.userContextId||0));
      if (!source) return;
      const event={type:source.service==='calendar'?'calendar':'native',sourceId:source.id,closed:topic==='web-notification-closed',key:`${source.service}:${source.id}:${p.origin}:${a.id}`,
        instance:String(a.countId ?? a.id), summary:a.title,detail:a.text,icon:a.imageURL,ts:Date.now()};
      if (!event.closed) { source.lastAlertAt=event.ts; this.activeAlerts.set(event.key,event); }
      else if (this.activeAlerts.get(event.key)?.instance===event.instance) this.activeAlerts.delete(event.key);
      this.emit(event);
    } catch (e) { this.emit({type:'error',message:'Desktop alert capture: '+e}); }
  }
  async request(url, ttl=0) {
    const now=Date.now(), cached=this.cache.get(url);
    if (cached && now-cached.at<ttl) return cached.data;
    if (this.requests.has(url)) return this.requests.get(url);
    const fail=this.failures.get(url); if (fail?.due>now) throw Error('Retrying after provider error');
    const win=this.owner?.window; if (!win) throw Error('No browser window');
    const task=(async()=>{
      const abort=new win.AbortController(), timer=win.setTimeout(()=>abort.abort(),8000);
      try {
        const response=await win.fetch(url,{credentials:'omit',signal:abort.signal});
        if (!response.ok) throw Error('ESPN HTTP '+response.status);
        const data=await response.json(); this.cache.set(url,{at:Date.now(),data}); this.failures.delete(url); return data;
      } catch(e) {
        const count=(this.failures.get(url)?.count || 0)+1;
        this.failures.set(url,{count,due:Date.now()+Math.min(900000,30000*2**(count-1))}); throw e;
      } finally {win.clearTimeout(timer);}
    })();
    this.requests.set(url,task);
    try {return await task;} finally {this.requests.delete(url);}
  }
  endpoint(league,path) {
    if (!LEAGUES[league]) throw Error('Unsupported league');
    return `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[league]}/${league}/${path}`;
  }
  async teams(league) {
    const data=await this.request(this.endpoint(league,'teams?limit=1000'),21600000);
    if (!Array.isArray(data?.sports?.[0]?.leagues?.[0]?.teams)) throw Error('Team directory unavailable');
    return parseTeams(data,league);
  }
  refresh(league,id) {
    this.scoreboardDue.delete(league);this.emitted.clear();
    this.cache.delete(this.endpoint(league,'scoreboard'));
    this.failures.delete(this.endpoint(league,'scoreboard'));
    if (id) this.failures.delete(this.endpoint(league,`teams/${encodeURIComponent(id)}/schedule`));
    if (id) {this.schedules.delete(teamKey(league,String(id)));this.cache.delete(this.endpoint(league,`teams/${encodeURIComponent(id)}/schedule`));}
  }
  async pollICal(conn) {
    let st = this.ical.get(conn.id) || {due: 0, count: 0, keys: new Map()};
    const now = Date.now();
    if (st.due > now) return;
    try {
      const win = this.owner?.window; if (!win) throw Error('No browser window');
      const abort = new win.AbortController(), timer = win.setTimeout(() => abort.abort(), 8000);
      let text;
      try {
        const res = await win.fetch(conn.url, {credentials: 'omit', cache: 'no-store', signal: abort.signal});
        if (!res.ok) throw Error('iCal HTTP ' + res.status);
        text = await res.text();
        if (text.length > 2000000) throw Error('Feed too large');
      } finally { win.clearTimeout(timer); }
      if (!this.state().enabled || !this.state().connections.some(c=>c.id===conn.id && c.url===conn.url && !c.paused)) return;
      if (!/^BEGIN:VCALENDAR\s*$/im.test(text) || !/^END:VCALENDAR\s*$/im.test(text)) throw Error('The URL did not return an iCal calendar');
      // Timed events starting within the lead window, plus ongoing ones.
      // All-day events never surface (they would pin the indicator all day).
      const events = parseICS(text, now, 2).filter(e => !e.allDay && e.endTs > now && e.startTs < now + ICAL_LEAD_MIN * 60 * 1000);
      const seen = new Set();
      for (const e of events) {
        const key = `ical:${conn.id}:${e.uid}@${e.startTs}`;
        seen.add(key);
        const ev = {type: 'calendar', sourceId: conn.id, closed: false, key, instance: String(e.startTs),
          summary: e.summary || '(No title)', detail: icalDetail(e), icon: '', ts: e.startTs, endTs:e.endTs};
        const old=st.keys.get(key);
        if (old?.summary===ev.summary && old?.detail===ev.detail && old?.endTs===ev.endTs) continue;
        st.keys.set(key, ev);
        this.emit({...ev});
      }
      for (const [key, ev] of [...st.keys]) {
        if (!seen.has(key)) { st.keys.delete(key); this.emit({...ev, closed: true}); }
      }
      st.count = 0; st.due = now + ICAL_POLL_MS;
      this.ical.set(conn.id, st);
      this.emit({type: 'providerStatus', key: conn.id, status: `Monitoring${events.length ? ` · ${events.length} upcoming` : ''}`});
    } catch (err) {
      if (!this.state().enabled || !this.state().connections.some(c=>c.id===conn.id && c.url===conn.url && !c.paused)) return;
      st.count = (st.count || 0) + 1;
      st.due = now + Math.min(ICAL_BACKOFF_CAP, 30000 * 2 ** (st.count - 1));
      this.ical.set(conn.id, st);
      this.emit({type: 'providerStatus', key: conn.id, stage: 'ical', status: 'Unavailable — ' + (err?.message || err)});
    }
  }
  pollNow(sourceId) {
    const target = (this.state().connections || []).find(c => c.id === sourceId && c.service === 'calendar' && c.ical && !c.paused);
    if (!target) return false;
    const st = this.ical.get(sourceId) || {due: 0, count: 0, keys: new Map()};
    st.due = 0;
    this.ical.set(sourceId, st);
    void this.tick();
    return true;
  }
  closeICal(connId) {
    const st = this.ical.get(connId);
    if (!st) return;
    for (const [, ev] of st.keys) this.emit({...ev, closed: true});
    this.ical.delete(connId);
  }
  async tick() {
    if (this.busy || !this.owner || !this.state().enabled) return;
    this.busy=true;
    try {
      const teams=Object.values(this.state().followedTeams).filter(t=>!t.paused), now=Date.now();
      // Expire cached reminders even while the feed is offline or backing off.
      for (const st of this.ical.values()) for (const [key,ev] of st.keys) {
        if (ev.endTs <= now) { st.keys.delete(key); this.emit({...ev,closed:true}); }
      }
      for (const t of teams) {
        const key=teamKey(t.league,t.id), old=this.schedules.get(key);
        if (!old || now-old.at>=21600000) {
          try {
            const data=await this.request(this.endpoint(t.league,`teams/${encodeURIComponent(t.id)}/schedule`),21600000);
            if (!Array.isArray(data?.events)) throw Error('Schedule unavailable');
            const games=parseGames(data,t.league);
            this.schedules.set(key,{at:now,games}); this.emit({type:'schedule',key,games,status:'Monitoring'});
          } catch(e) {this.emit({type:'providerStatus',key,stage:'schedule',status:'Unavailable — '+e.message});}
        } else if (!t.schedule) this.emit({type:'schedule',key,games:old.games,status:'Monitoring'});
      }
      for (const league of new Set(teams.map(t=>t.league))) {
        if ((this.scoreboardDue.get(league)||0)>now) continue;
        try {
          const data=await this.request(this.endpoint(league,'scoreboard'),25000);
          if (!Array.isArray(data?.events)) throw Error('Scoreboard unavailable');
          const games=parseGames(data,league);
          const ids=new Set(teams.filter(t=>t.league===league).map(t=>t.id));
          const relevant=games.filter(g=>g.teamIds.some(id=>ids.has(id)));
          for (const g of relevant) {
            const hash=JSON.stringify(g); if (hash===this.emitted.get(g.id)) continue;
            this.emitted.set(g.id,hash); this.emit({type:'game',game:g});
          }
          const near=teams.filter(t=>t.league===league).some(t=>(this.schedules.get(teamKey(league,t.id))?.games||[]).some(g=>Math.abs(g.startTs-now)<86400000));
          this.scoreboardDue.set(league,now+(relevant.some(g=>g.state==='in')?30000:near?300000:21600000));
          for (const t of teams.filter(t=>t.league===league)) this.emit({type:'providerStatus',key:teamKey(league,t.id),status:'Monitoring'});
        } catch(e) {
          this.scoreboardDue.set(league,now+30000);
          for (const t of teams.filter(t=>t.league===league)) this.emit({type:'providerStatus',key:teamKey(league,t.id),status:'Unavailable — '+e.message});
        }
      }
      for (const c of (this.state().connections || []).filter(c => c.service === 'calendar' && c.ical && !c.paused)) {
        await this.pollICal(c);
      }
    } finally {this.busy=false;}
  }
  // End-to-end self test for the Calendar feed path. Bypasses platform
  // capture and injects a clearly labeled card; proves the inbox, indicator
  // and dismiss flow work. If this card appears but real reminders never do,
  // the problem is upstream: Google Calendar desktop notifications or Zen's
  // site permission for calendar.google.com.
  sendTestReminder(sourceId) {
    const target=(this.state().connections||[]).find(c=>c.id===sourceId && NATIVE_APPS[c.service] && !c.ical && !c.paused);
    if (!target || !this.owner || !this.state().enabled) return false;
    const now=Date.now();
    this.emit({type:target.service==='calendar'?'calendar':'native',sourceId:target.id,closed:false,key:`${target.service}:test:${target.id}`,instance:'test-'+now,
      summary:target.service==='calendar'?'Test reminder':'Test alert',detail:'The inbox works. This test does not check app notification permissions.',icon:'',ts:now});
    return true;
  }
  diagnostics() {return {calendar:this.calendarStatus(),capture:this.capture,alertsSeen:this.seenAlerts,lastAlertAt:this.lastAlertAt,lastAlertOrigin:this.lastAlertOrigin,pending:this.requests.size,failures:Object.fromEntries(this.failures),followedTeams:Object.keys(this.state().followedTeams).length};}
}
export const Sources = new SourceCoordinator();
