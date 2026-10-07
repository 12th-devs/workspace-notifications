export function mailDate(raw, now = Date.now()) {
  raw = String(raw || '').trim();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  if (/^\d{10}$|^\d{13}$/.test(raw)) return {ts:Number(raw) * (raw.length === 10 ? 1000 : 1), precision:'time'};
  const clock = raw.match(/^(?:(today|yesterday)\s*,?\s*)?(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (clock) {
    let h = Number(clock[2]), m = Number(clock[3]);
    if (m > 59 || h > (clock[4] ? 12 : 23) || (clock[4] && h < 1)) return {ts:0, precision:'unknown'};
    if (clock[4]) h = h % 12 + (/pm/i.test(clock[4]) ? 12 : 0);
    if (/yesterday/i.test(clock[1] || '')) today.setDate(today.getDate()-1);
    today.setHours(h,m);
    // Gmail uses clock labels for recent mail spanning midnight.
    if (!clock[1] && +today > now) today.setDate(today.getDate()-1);
    return {ts:today.getTime(), precision:'time'};
  }
  if (/^(today|yesterday)$/i.test(raw)) {
    if (/yesterday/i.test(raw)) today.setDate(today.getDate()-1);
    return {ts:today.getTime(), precision:'day'};
  }
  const short = raw.match(/^([a-z]{3,9})\s+(\d{1,2})$/i);
  if (short) {
    let d = new Date(raw + ', ' + today.getFullYear());
    if (Number.isFinite(+d) && d.getDate() === Number(short[2])) {
      if (+d > now) d.setFullYear(d.getFullYear()-1);
      return {ts:+d, precision:'day'};
    }
  }
  if (/\b\d{4}\b/.test(raw)) {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return {ts, precision:/\d:\d/.test(raw) ? 'time' : 'day'};
  }
  return {ts:0, precision:'unknown'};
}

export function notificationTime(n, now=Date.now()) {
  if (n.service === 'gmail' && (!n.mailTimeKnown || n.mailPrecision === 'day')) return n.mailDate || 'Date unavailable';
  if (!n.ts) return '';
  const date=new Date(n.ts), today=new Date(now);
  if (!Number.isFinite(+date)) return '';
  const options={hour:'numeric',minute:'2-digit'};
  if (date.toDateString() !== today.toDateString()) {options.month='short';options.day='numeric';}
  if (date.getFullYear() !== today.getFullYear()) options.year='numeric';
  return date.toLocaleString(undefined,options);
}

export function compareNotifications(a,b) {
  const time = n => n.service === 'gmail' ? (n.mailTimeKnown ? n.ts : 0) : n.ts;
  return Number(!!b.nativeActive)-Number(!!a.nativeActive) || (time(b)||0)-(time(a)||0) || String(a.sourceId||'').localeCompare(String(b.sourceId||'')) ||
    (a.sourceRank ?? 0)-(b.sourceRank ?? 0) || String(a.itemId||a.id).localeCompare(String(b.itemId||b.id));
}

export const LEAGUES = {nfl:'football', nba:'basketball', mlb:'baseball', nhl:'hockey'};
export const teamKey = (league,id) => `espn:${league}:${id}`;
export function parseTeams(data, league) {
  return (data.sports?.[0]?.leagues?.[0]?.teams || []).map(({team:t}) => ({
    id:String(t.id), league, provider:'espn', name:t.displayName, abbreviation:t.abbreviation,
    logo:t.logos?.[0]?.href || '', url:t.links?.find(l=>l.rel?.includes('clubhouse'))?.href || ''
  })).filter(t=>t.id && t.name);
}
export function parseGames(data, league) {
  return (data.events || []).flatMap(e => {
    const c = e.competitions?.[0], home = c?.competitors?.find(t=>t.homeAway==='home'), away=c?.competitors?.find(t=>t.homeAway==='away');
    if (!home?.team || !away?.team) return [];
    const st=c.status || e.status || {}, state=st.type?.state || 'pre';
    return [{id:`espn:${league}:${e.id}`, provider:'espn', league, teamIds:[String(home.team.id),String(away.team.id)],
      home:home.team.displayName, away:away.team.displayName, homeAbbr:home.team.abbreviation, awayAbbr:away.team.abbreviation,
      homeIcon:home.team.logo || home.team.logos?.[0]?.href || '', awayIcon:away.team.logo || away.team.logos?.[0]?.href || '',
      homeScore:state==='pre' ? '' : home.score?.displayValue ?? home.score ?? '', awayScore:state==='pre' ? '' : away.score?.displayValue ?? away.score ?? '',
      state, completed:!!st.type?.completed, status:st.type?.shortDetail || st.type?.description || state,
      startTs:Date.parse(e.date) || 0, sport:LEAGUES[league], url:e.links?.find(l=>l.rel?.includes('summary'))?.href || `https://www.espn.com/${league}/game/_/gameId/${e.id}`}];
  });
}

// ---------------------------------------------------------------- iCal feeds
//
// Minimal ICS subscription parsing for calendar feeds: UTC, floating-local,
// all-day and TZID wall times (via VTIMEZONE STANDARD/DAYLIGHT rules), plus
// DAILY/WEEKLY recurrence. Unknown TZIDs fall back to floating-local time.
// RECURRENCE-ID overrides and EXDATE removals are not applied.

const ICS_WDAYS = {SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};

function icsOffsetMs(text) {
  const m = String(text || '').trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * ((+m[2]) * 3600000 + (+m[3]) * 60000 + (+(m[4] || 0)) * 1000);
}

function icsNthWeekday(year, month0, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const dow = new Date(Date.UTC(year, month0, last)).getUTCDay();
  return last - ((dow - weekday + 7) % 7);
}

function icsParseRuleTransition(rule, year) {
  // Supports the common VTIMEZONE form: DTSTART + RRULE:FREQ=YEARLY;BYMONTH=M;BYDAY=nWD.
  const dt = String(rule.dtstart || '');
  const day = rule.byday && ICS_WDAYS[rule.byday.slice(-2)] !== undefined ? ICS_WDAYS[rule.byday.slice(-2)] : null;
  if (!rule.bymonth || day === null) {
    const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  const n = rule.byday.length > 2 ? parseInt(rule.byday, 10) : 0;
  const dom = icsNthWeekday(year, rule.bymonth - 1, day, n || -1);
  const m = dt.match(/T(\d{2})(\d{2})(\d{2})?$/);
  return Date.UTC(year, rule.bymonth - 1, dom, +(m?.[1] || 0), +(m?.[2] || 0), +(m?.[3] || 0));
}

function icsOffsetAt(tz, wallTs, year) {
  if (!tz || !tz.rules.length) return 0;
  const transitions = [];
  for (let y = year - 1; y <= year + 1; y++) {
    for (const r of tz.rules) {
      const at = icsParseRuleTransition(r, y);
      if (at !== null) transitions.push({at, offset: r.offsetTo});
    }
  }
  transitions.sort((a, b) => a.at - b.at);
  let offset = transitions.length ? transitions[0].offset : 0;
  for (const t of transitions) {
    if (t.at <= wallTs) offset = t.offset;
    else break;
  }
  return offset;
}

function icsParseParams(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  return out;
}

function icsParseDuration(text) {
  const m = String(text || '').trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (((+(m[2] || 0)) * 7 + (+(m[3] || 0))) * 86400000 + (+(m[4] || 0)) * 3600000 + (+(m[5] || 0)) * 60000 + (+(m[6] || 0)) * 1000);
}

function icsParseDateValue(value, params, timezones) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return {ts: new Date(+m[1], +m[2] - 1, +m[3]).getTime(), allDay: true};
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
  if (m[7] === 'Z') return {ts: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false};
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const tzid = params.TZID;
  if (tzid && timezones[tzid]) return {ts: wallAsUtc - icsOffsetAt(timezones[tzid], wallAsUtc, y), allDay: false};
  return {ts: new Date(y, mo - 1, d, h, mi, s).getTime(), allDay: false};
}

function icsParseRRule(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  }
  return {
    freq: (out.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(out.INTERVAL || '1', 10) || 1),
    count: out.COUNT ? parseInt(out.COUNT, 10) : 0,
    until: out.UNTIL || '',
    byday: (out.BYDAY || '').split(',').map(s => s.trim()).filter(s => ICS_WDAYS[s.slice(-2)] !== undefined),
  };
}

function icsWallOf(value) {
  const m = String(value || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  return {y: +m[1], mo: +m[2] - 1, d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0)};
}

export function parseICS(text, now = Date.now(), horizonDays = 2) {
  const rawLines = String(text || '').split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const timezones = {};
  const vevents = [];
  let block = null, current = null;
  const pushBlock = () => {
    if (block === 'VTIMEZONE' && current?.id) {
      timezones[current.id] = current;
    } else if (block === 'VEVENT' && current) {
      vevents.push(current);
    }
  };
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const semi = head.indexOf(';');
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? {} : icsParseParams(head.slice(semi + 1));
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VTIMEZONE') { block = 'VTIMEZONE'; current = {id: '', rules: []}; }
      else if (value.toUpperCase() === 'VEVENT') { block = 'VEVENT'; current = {props: []}; }
      else if (block === 'VTIMEZONE' && (value.toUpperCase() === 'STANDARD' || value.toUpperCase() === 'DAYLIGHT')) current._sub = {kind: value.toUpperCase(), dtstart: '', offsetTo: 0, rrule: null};
      continue;
    }
    if (name === 'END') {
      const v = value.toUpperCase();
      if ((v === 'STANDARD' || v === 'DAYLIGHT') && block === 'VTIMEZONE' && current?._sub) {
        current.rules.push(current._sub);
        current._sub = null;
      } else if (v === block) {
        pushBlock();
        block = null; current = null;
      }
      continue;
    }
    if (block === 'VTIMEZONE' && current) {
      if (name === 'TZID' && !current._sub) current.id = value;
      else if (current._sub) {
        if (name === 'DTSTART') current._sub.dtstart = value;
        else if (name === 'TZOFFSETTO') current._sub.offsetTo = icsOffsetMs(value);
        else if (name === 'RRULE') {
          const r = icsParseRRule(value);
          const bymonth = parseInt((value.match(/BYMONTH=(\d+)/) || [])[1] || '0', 10);
          const byday = (value.match(/BYDAY=([^;]+)/) || [])[1] || '';
          current._sub.bymonth = bymonth;
          current._sub.byday = byday.split(',')[0] || '';
          void r;
        }
      }
    } else if (block === 'VEVENT' && current) {
      current.props.push({name, params, value});
    }
  }
  if (block && current) pushBlock();

  const horizonTs = now + Math.max(1, horizonDays) * 86400000;
  const fromTs = now - 2 * 3600000;
  const out = [];
  for (const ev of vevents) {
    const get = (n) => ev.props.filter(p => p.name === n);
    if (get('STATUS').some(p => p.value.toUpperCase() === 'CANCELLED')) continue;
    const uid = (get('UID')[0]?.value || '').slice(0, 200);
    const summary = (get('SUMMARY')[0]?.value || '(No title)').replace(/\\([,;\\nN])/g, (_, c) => c === 'n' || c === 'N' ? '\n' : c).slice(0, 200);
    const description = (get('DESCRIPTION')[0]?.value || '').replace(/\\n/gi, '\n').slice(0, 300);
    const location = (get('LOCATION')[0]?.value || '').replace(/\\([,;])/g, '$1').slice(0, 120);
    const dtstart = get('DTSTART')[0];
    if (!dtstart) continue;
    const start0 = icsParseDateValue(dtstart.value, dtstart.params, timezones);
    if (!start0) continue;
    const dtend = get('DTEND')[0];
    const dur = get('DURATION')[0];
    let span = 0;
    if (dtend) {
      const e = icsParseDateValue(dtend.value, dtend.params, timezones);
      span = e ? Math.max(0, e.ts - start0.ts) : 0;
    } else if (dur) {
      span = Math.max(0, icsParseDuration(dur.value));
    }
    if (start0.allDay && span === 0) span = 86400000;
    const rrule = get('RRULE')[0];
    const occurrences = [];
    if (!rrule || !['DAILY', 'WEEKLY'].includes(icsParseRRule(rrule.value).freq)) {
      occurrences.push({startTs: start0.ts, endTs: start0.ts + span});
    } else {
      const rule = icsParseRRule(rrule.value);
      const untilTs = rule.until ? (icsParseDateValue(rule.until, {}, timezones)?.ts || Infinity) : Infinity;
      // Expand in the event's own wall frame (UTC wall for Z times, TZID wall
      // when known, local wall otherwise) so DST never shifts the clock time.
      const wall0 = icsWallOf(dtstart.value) || {y: 1970, mo: 0, d: 1, h: 0, mi: 0, s: 0};
      const isUtcEvent = /Z$/.test(String(dtstart.value).trim());
      const tzidKnown = !!(dtstart.params.TZID && timezones[dtstart.params.TZID]);
      const toTs = (parts) => {
        if (isUtcEvent) return Date.UTC(parts.y, parts.mo, parts.d, parts.h, parts.mi, parts.s);
        if (tzidKnown) {
          const wallAsUtc = Date.UTC(parts.y, parts.mo, parts.d, parts.h, parts.mi, parts.s);
          return wallAsUtc - icsOffsetAt(timezones[dtstart.params.TZID], wallAsUtc, parts.y);
        }
        return new Date(parts.y, parts.mo, parts.d, parts.h, parts.mi, parts.s).getTime();
      };
      const dayMs = 86400000;
      const dateOf = (baseMs, deltaDays) => {
        const n = new Date(baseMs + deltaDays * dayMs);
        return {y: n.getUTCFullYear(), mo: n.getUTCMonth(), d: n.getUTCDate()};
      };
      let made = 0, guard = 0;
      if (rule.freq === 'DAILY') {
        let wy = wall0.y, wmo = wall0.mo, wd = wall0.d;
        while (made < (rule.count || Infinity) && guard++ < 1000) {
          const ts = toTs({y: wy, mo: wmo, d: wd, h: wall0.h, mi: wall0.mi, s: wall0.s});
          if (ts > horizonTs || ts > untilTs) break;
          made++;
          if (ts + span >= fromTs && ts <= horizonTs) occurrences.push({startTs: ts, endTs: ts + span});
          ({y: wy, mo: wmo, d: wd} = dateOf(Date.UTC(wy, wmo, wd), rule.interval));
        }
      } else {
        const startDow = new Date(Date.UTC(wall0.y, wall0.mo, wall0.d)).getUTCDay();
        const days = (rule.byday.length ? rule.byday : [Object.keys(ICS_WDAYS).find(k => ICS_WDAYS[k] === startDow) || 'MO'])
          .map(d => ICS_WDAYS[d.slice(-2)]).sort((a, b) => a - b);
        const weekStartMs = Date.UTC(wall0.y, wall0.mo, wall0.d) - startDow * dayMs;
        let week = 0;
        outer: while (made < (rule.count || Infinity) && guard++ < 1000) {
          for (const dow of days) {
            const dd = dateOf(weekStartMs, week * rule.interval * 7 + dow);
            const ts = toTs({y: dd.y, mo: dd.mo, d: dd.d, h: wall0.h, mi: wall0.mi, s: wall0.s});
            if (made >= (rule.count || Infinity)) break outer;
            if (ts > horizonTs || ts > untilTs) {
              if (ts > horizonTs && dow === days[days.length - 1]) break outer;
              continue;
            }
            if (ts + span < fromTs) { made++; continue; }
            made++;
            occurrences.push({startTs: ts, endTs: ts + span});
          }
          week++;
          if (week * rule.interval > 520) break;
        }
      }
    }
    for (const o of occurrences) {
      if (o.endTs >= fromTs && o.startTs <= horizonTs) {
        out.push({uid: uid || `${summary}|${o.startTs}`, summary, description, location, startTs: o.startTs, endTs: o.endTs, allDay: start0.allDay});
      }
    }
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}
