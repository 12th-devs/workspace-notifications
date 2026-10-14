// Compare observed snapshots, never reconstruct scores or periods we missed.
function state(g) {
  if (!g) return '';
  if (g.completed || /final|game over/i.test(g.status || '')) return 'post';
  if (g.state) return g.state;
  return /live|q\d|half|quarter|inning|period|\bot\b|end of/i.test(g.status || '') ? 'in' : 'pre';
}

export function gamePeriod(g) {
  const text=String(g.status || ''), sport=g.sport || '', league=g.league || '';
  const unit=/nfl|nba/.test(league) || /football|basketball/.test(sport) ? 'quarter' :
    league==='nhl' || sport==='hockey' ? 'period' : league==='mlb' || sport==='baseball' ? 'inning' : /\bq[1-4]\b|quarter/i.test(text) ? 'quarter' : '';
  let number=Number(g.period) || 0;
  if (!number) {
    const match=text.match(/\bQ([1-4])\b/i) || text.match(/\b([1-9]\d*)(?:st|nd|rd|th)?\s*(?:quarter|period|inning)\b/i) ||
      text.match(/\b(?:quarter|period|inning)\s*([1-9]\d*)\b/i) || text.match(/\b(?:end of|top|bottom|mid|end)\s*(?:the\s*)?([1-9]\d*)(?:st|nd|rd|th)?\b/i);
    number=Number(match?.[1] || (unit ? text.match(/^([1-9]\d*)(?:st|nd|rd|th)$/i)?.[1] : '')) || (/half\s*time/i.test(text) && unit==='quarter' ? 2 : 0);
  }
  const regulation=unit==='quarter'?4:unit==='period'?3:unit==='inning'?9:0;
  const overtime=/\bot\b|overtime/i.test(text) || (regulation && number>regulation);
  const label=overtime && unit!=='inning' ? 'Overtime'+(number>regulation+1?' '+(number-regulation):'') : number && unit ? unit[0].toUpperCase()+unit.slice(1)+' '+number : '';
  const clock=String(g.displayClock || text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || '');
  const ended=/END_PERIOD|HALFTIME/i.test(g.statusName || '') || /end of|\bend\b|half\s*time|intermission/i.test(text) || (clock==='0:00' && state(g)==='in');
  return {unit,number,label,ended};
}

export function gameTransitions(previous,current) {
  const before=state(previous),after=state(current),events=[];
  const add=(key,title,kind)=>events.push({key,title,kind});
  // Joining an already-live game does not invent scoring or period boundaries.
  if (!previous) {
    if(after==='in') add('game:start','Game live','start');
    return events;
  }
  if (before==='post') return events;
  if (after==='in' && before==='pre') add('game:start','Game started','start');
  if (before==='in' && (after==='in' || after==='post')) {
    const score=v=>v!=='' && v!=null && Number.isFinite(Number(v)) ? Number(v) : null;
    const ah=score(previous.homeScore),aa=score(previous.awayScore),bh=score(current.homeScore),ba=score(current.awayScore);
    if ([ah,aa,bh,ba].every(v=>v!==null) && (ah!==bh || aa!==ba)) {
      const scorers=[ba>aa ? current.awayAbbr || current.away : '', bh>ah ? current.homeAbbr || current.home : ''].filter(Boolean);
      const corrected=bh<ah || ba<aa;
      add(`score:${aa}:${ah}>${ba}:${bh}`,corrected?'Score corrected':scorers.join(' & ')+' scores','score');
    }
  }
  const old=gamePeriod(previous),next=gamePeriod(current);
  if (before==='in' && old.unit && old.number && next.unit===old.unit && next.number>=old.number) {
    if (!old.ended && (next.ended || next.number>old.number || after==='post')) add(`period:end:${old.number}`,old.label+' ended','period');
    if (after==='in' && next.number>old.number) {
      if(next.ended)add(`period:end:${next.number}`,next.label+' ended','period');
      else add(`period:start:${next.number}`,next.label+' started','period');
    }
  } else if (before==='pre' && after==='in' && next.label) add(`period:start:${next.number}`,next.label+' started','period');
  if (after==='post' && (before==='in' || before==='pre')) add('game:end','Game ended','final');
  return events;
}

export function gameScoreStatus(g) {
  const text=String(g.status || '').trim();
  if(g.completed || g.state==='post' || /\bfinal\b/i.test(text))return text && /\bfinal\b/i.test(text) ? text : 'Final';
  if(/half\s*time/i.test(text) || /HALFTIME/i.test(g.statusName || ''))return 'Halftime';
  if(/intermission/i.test(text))return 'Intermission';
  if(g.state==='pre')return text && !/^(pre|in)$/i.test(text) ? text : 'Scheduled';
  const p=gamePeriod(g);
  const period=p.label.startsWith('Overtime') ? p.label.replace('Overtime','OT') :
    p.number && p.unit==='quarter' ? 'Q'+p.number : p.number && p.unit==='period' ? 'P'+p.number : '';
  const rawClock=String(g.displayClock || text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || '');
  const clock=/^\d{1,2}:[0-5]\d$/.test(rawClock) ? rawClock : '';
  if(p.ended && period)return 'End '+period;
  if(period)return [period,clock].filter(Boolean).join(' ● ');
  return text && !/^(pre|in|post)$/i.test(text) ? text : clock || '';
}
