import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {mailDate,notificationTime,compareNotifications,parseGames,parseTeams,LEAGUES,parseICS} from '../NotificationData.sys.mjs';

test('mail dates preserve precision and roll December into previous year',()=>{
  const now=+new Date(2026,0,2,10);
  assert.equal(mailDate('Dec 31',now).ts,+new Date(2025,11,31));
  assert.equal(mailDate('Yesterday',now).ts,+new Date(2026,0,1));
  assert.equal(mailDate('8:45 AM',now).ts,+new Date(2026,0,2,8,45));
  assert.equal(mailDate('10:22 PM',now).ts,+new Date(2026,0,1,22,22));
  assert.equal(mailDate('Yesterday 11:59 PM',now).ts,+new Date(2026,0,1,23,59));
  assert.equal(mailDate('Jan 1',now).precision,'day');
  assert.equal(mailDate('2026-01-01T15:00:00-05:00').ts,Date.parse('2026-01-01T20:00:00Z'));
  assert.equal(mailDate('1760000000').ts,1760000000000);
  assert.equal(mailDate('1760000000000').ts,1760000000000);
  assert.equal(mailDate('unparseable').ts,0);
  assert.equal(mailDate('25:80').ts,0);
});
test('iCal parses UTC, floating, all-day and TZID wall times',()=>{
  const now=Date.UTC(2026,9,2,12,0);
  const ics=['BEGIN:VCALENDAR','BEGIN:VTIMEZONE','TZID:America/New_York','BEGIN:DAYLIGHT','DTSTART:20070311T020000','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','DTSTART:20071104T020000','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE',
    'BEGIN:VEVENT','UID:utc-1','DTSTART:20261002T140000Z','DTEND:20261002T150000Z','SUMMARY:UTC standup','END:VEVENT',
    'BEGIN:VEVENT','UID:ny-1','DTSTART;TZID=America/New_York:20261002T100000','DTEND;TZID=America/New_York:20261002T101500','SUMMARY:NY standup','LOCATION:Room 3','END:VEVENT',
    'BEGIN:VEVENT','UID:day-1','DTSTART;VALUE=DATE:20261002','SUMMARY:Holiday','END:VEVENT',
    'BEGIN:VEVENT','UID:cancel-1','DTSTART:20261002T140000Z','STATUS:CANCELLED','SUMMARY:Gone','END:VEVENT',
    'BEGIN:VEVENT','UID:fold-1','DTSTART:20261002T160000Z','DESCRIPTION:long line that',' continues here','SUMMARY:Folded','END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const evs=parseICS(ics,now,2);
  const byId=Object.fromEntries(evs.map(e=>[e.uid,e]));
  assert.equal(byId['utc-1'].startTs,Date.UTC(2026,9,2,14,0));
  assert.equal(byId['utc-1'].endTs,Date.UTC(2026,9,2,15,0));
  assert.equal(byId['ny-1'].startTs,Date.UTC(2026,9,2,14,0));
  assert.equal(byId['ny-1'].location,'Room 3');
  assert.equal(byId['day-1'].allDay,true);
  assert.ok(!byId['cancel-1']);
  assert.equal(byId['fold-1'].description,'long line thatcontinues here');
});
test('iCal expands daily and weekly recurrence within the horizon',()=>{
  const now=Date.UTC(2026,9,2,12,0);
  const ics=['BEGIN:VCALENDAR',
    'BEGIN:VEVENT','UID:daily-1','DTSTART:20261001T090000Z','DTEND:20261001T093000Z','RRULE:FREQ=DAILY;COUNT=5','SUMMARY:Daily','END:VEVENT',
    'BEGIN:VEVENT','UID:weekly-1','DTSTART:20260928T090000Z','DTEND:20260928T100000Z','RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3','SUMMARY:Weekly review','END:VEVENT',
    'END:VCALENDAR'].join('\n');
  const evs=parseICS(ics,now,14);
  assert.deepEqual(evs.filter(e=>e.uid==='daily-1').map(e=>e.startTs),[Date.UTC(2026,9,3,9,0),Date.UTC(2026,9,4,9,0),Date.UTC(2026,9,5,9,0)]);
  assert.deepEqual(evs.filter(e=>e.uid==='weekly-1').map(e=>e.startTs),[Date.UTC(2026,9,5,9,0),Date.UTC(2026,9,12,9,0)]);
});
test('notification labels show actual clock times with older dates and never elapsed ages',()=>{
  const now=+new Date(2026,9,2,10,30);
  const label=notificationTime({service:'gmail',mailTimeKnown:true,mailPrecision:'time',ts:+new Date(2026,9,2,9,55)},now);
  assert.match(label,/9:55/);assert.doesNotMatch(label,/ago|just now/);
  const older=notificationTime({service:'gmail',mailTimeKnown:true,mailPrecision:'time',ts:+new Date(2026,9,1,22,22)},now);
  assert.match(older,/Oct/);assert.match(older,/10:22|22:22/);
  assert.equal(notificationTime({service:'gmail',mailTimeKnown:true,mailPrecision:'day',mailDate:'Oct 1',ts:+new Date(2026,9,1)},now),'Oct 1');
});
test('newest-first sorting excludes scan time and has stable ties across accounts',()=>{
  const n=(id,ts,known=true)=>({id,service:'gmail',sourceId:'a',ts,mailTimeKnown:known});
  const items=[n('old',5),n('unknown',99999,false),n('new',10),{...n('tie',10),sourceId:'b'}];
  assert.deepEqual(items.sort(compareNotifications).map(x=>x.id),['new','tie','old','unknown']);
  assert.deepEqual(items.reverse().sort(compareNotifications).map(x=>x.id),['new','tie','old','unknown']);
});
const event=(id,state='in',completed=false)=>({id,date:'2026-10-02T00:15Z',status:{type:{state,completed,shortDetail:'Q4'}},competitions:[{competitors:[{homeAway:'home',team:{id:'5',displayName:'Cleveland Browns',abbreviation:'CLE',logo:'https://example.com/cle.png'},score:'27'},{homeAway:'away',team:{id:'23',displayName:'Pittsburgh Steelers',abbreviation:'PIT',logo:'https://example.com/pit.png'},score:'24'}]}]});
for(const league of Object.keys(LEAGUES)) test(league+' adapter preserves provider IDs, names, logos and repeated matchups',()=>{
  const games=parseGames({events:[event('1'),event('2'),event('3','pre'),event('4','post',true)]},league);
  assert.notEqual(games[0].id,games[1].id);assert.equal(games[0].home,'Cleveland Browns');assert.equal(games[0].awayScore,'24');
  assert.equal(games[0].awayIcon,'https://example.com/pit.png');assert.deepEqual(games[0].teamIds,['5','23']);
  assert.equal(games[2].homeScore,'');assert.equal(games[3].completed,true);
  assert.equal(parseGames({events:[{id:'missing'}]},league).length,0);
  const teams=parseTeams({sports:[{leagues:[{teams:[{team:{id:'23',displayName:'Pittsburgh Steelers',abbreviation:'PIT',logos:[{href:'https://example.com/pit.png'}]}}]}]}]},league);
  assert.equal(teams[0].id,'23');assert.equal(teams[0].league,league);
});

function harness() {
  const window={addEventListener(){},PrivateBrowsingUtils:{isWindowPrivate:()=>false}};
  const document={readyState:'loading'};
  let source=readFileSync(new URL('../workspace-notifications.uc.js',import.meta.url),'utf8');
  source=source.replace('  if (document.readyState === "complete") init();','  window.test={loadStore,ingestGmail,ingestGitHub,prune,serialize,handleSourceEvent,gameActive,unpinFromIndicator,currentPinnedNotification,addICalConnection}; compareNotifications=window.compare; onNewBrief=()=>{}; renderAll=()=>{};\n  if (false) init();');
  window.compare=compareNotifications;
  vm.runInNewContext(source,{window,document,Services:{dirsvc:{get:()=>({path:'profile'})},prefs:{getBoolPref:(_p,d)=>d},obs:{notifyObservers(){}}},Ci:{nsIFile:{}},URL,console,setTimeout:()=>0,clearTimeout(){},IOUtils:{readUTF8:()=>Promise.resolve(JSON.stringify(window.disk)),writeUTF8:()=>Promise.resolve()},PathUtils:{join:(...s)=>s.join('/')}});
  return {t:window.test,store:window.WorkspaceNotifications.store,window};
}
test('restore preserves full timestamps and new native app connections',async()=>{
  const {t,store,window}=harness(),now=Date.now();
  window.disk={v:2,connections:[{id:'slack',service:'slack',url:'https://app.slack.com',lastOkTs:now,lastScanTs:now,lastAlertAt:now}],notifications:[]};
  t.loadStore();await new Promise(r=>setImmediate(r));
  assert.equal(store.connections[0].service,'slack');assert.equal(store.connections[0].lastOkTs,now);assert.equal(store.connections[0].lastScanTs,now);assert.equal(t.serialize().connections[0].lastAlertAt,now);
});
test('native app alerts stay chronological and do not become live Calendar cards',()=>{
  const {t,store}=harness();store.connections=[{id:'slack',service:'slack',url:'https://app.slack.com'}];
  const ev={type:'native',sourceId:'slack',key:'alert',instance:'1',summary:'Message',ts:Date.now()};
  t.handleSourceEvent(ev);t.handleSourceEvent(ev);assert.equal(store.notifications.length,1);assert.equal(store.notifications[0].service,'slack');assert.equal(store.notifications[0].nativeActive,false);
  t.handleSourceEvent({...ev,instance:'2',summary:'New message'});assert.equal(store.notifications.length,1);assert.equal(store.notifications[0].summary,'New message');
});
test('updated iCal events revise the existing card without duplicating it',()=>{
  const {t,store}=harness();store.connections=[{id:'cal',service:'calendar',ical:true}];
  const ev={type:'calendar',sourceId:'cal',key:'event',instance:'1',summary:'Standup',detail:'Room 1',ts:Date.now()};
  t.handleSourceEvent(ev);t.handleSourceEvent({...ev,summary:'Updated standup',detail:'Room 2'});assert.equal(store.notifications.length,1);assert.equal(store.notifications[0].detail,'Room 2');
});
test('unread ingestion preserves message time, suppresses opened/dismissed mail and accepts new reply',()=>{
  const {t,store}=harness(),c={id:'mail',baseline:new Set(),baselineFp:{},openedMail:{}};
  const m={id:'gmail:1',ts:50,summary:'Mail',fingerprint:'first',meta:{unread:true,precision:'day',date:'Jan 1'}};
  t.ingestGmail(c,[m], 'Account 1',true,{});assert.equal(store.notifications[0].ts,50);assert.equal(store.notifications[0].mailPrecision,'day');
  c.openedMail[m.id]='first';t.ingestGmail(c,[m],'Account 1',true,{});assert.equal(store.notifications.length,0);
  t.ingestGmail(c,[{...m,ts:80,fingerprint:'reply'}],'Account 1',true,{});assert.equal(store.notifications[0].ts,80);
  store.dismissIds[store.notifications[0].id]=Date.now();t.ingestGmail(c,[{...m,ts:80,fingerprint:'reply'}],'Account 1',true,{});assert.equal(store.notifications.length,0);
  t.ingestGmail(c,[],'Account 1',true,{readIds:[m.id]});assert.equal(Object.keys(c.openedMail).length,0);
  t.ingestGmail(c,[{...m,id:'unknown',ts:0}],'Account 1',true,{});assert.equal(store.notifications[0].ts,0);
});
test('storage limits apply after chronology sorting',()=>{
  const {t,store}=harness();store.notifications=Array.from({length:120},(_,i)=>({id:String(i),service:'gmail',ts:i,mailTimeKnown:true,summary:'Mail'}));
  t.prune();assert.equal(store.notifications.length,100);assert.equal(store.notifications[0].ts,119);assert.equal(store.notifications.at(-1).ts,20);
});
test('GitHub mirrors only unread threads, accepts revisions and suppresses opened notifications',()=>{
  const {t,store}=harness(),c={id:'github',baseline:new Set(),baselineFp:{}};
  const thread={id:'github:thread:42',summary:'Review requested',url:'https://github.com/org/repo/pull/12',ts:Date.now(),fingerprint:'first',meta:{unread:true}};
  t.ingestGitHub(c,[thread],true);assert.equal(store.notifications.length,1);assert.equal(store.notifications[0].githubVerified,true);
  c.openedGithub[thread.id]='first';t.ingestGitHub(c,[thread],false);assert.equal(store.notifications.length,0);
  t.ingestGitHub(c,[{...thread,fingerprint:'new-comment'}],false);assert.equal(store.notifications.length,1);
  t.ingestGitHub(c,[],false);assert.equal(store.notifications.length,0);
  t.ingestGitHub(c,[{...thread,meta:{unread:false}}],false);assert.equal(store.notifications.length,0);
});
test('following both competitors yields one start/final alert per event and handles repeated matchups',()=>{
  const {t,store}=harness();store.followedTeams={'espn:nfl:23':{id:'23',league:'nfl'},'espn:nfl:5':{id:'5',league:'nfl'}};
  const game=parseGames({events:[event('one')]},'nfl')[0];
  t.handleSourceEvent({type:'game',game});t.handleSourceEvent({type:'game',game:{...game,homeScore:'28'}});
  assert.equal(store.notifications.length,1);assert.equal(Object.keys(store.followedGames).length,1);
  t.handleSourceEvent({type:'game',game:{...game,state:'post',completed:true}});t.handleSourceEvent({type:'game',game:{...game,state:'post',completed:true}});
  assert.equal(store.notifications.length,2);
  t.handleSourceEvent({type:'game',game:{...game,id:'espn:nfl:two'}});assert.equal(store.notifications.length,3);
  Object.values(store.followedTeams).forEach(t=>t.paused=true);t.handleSourceEvent({type:'game',game:{...game,id:'ignored'}});assert.equal(store.notifications.length,3);
});
test('Calendar replacements update one card and stale close callbacks cannot close its replacement',()=>{
  const {t,store}=harness();store.connections=[{id:'cal',service:'calendar',url:'https://calendar.google.com'}];
  const show={type:'calendar',sourceId:'cal',key:'tag',instance:'1',summary:'Reminder',detail:'Event',ts:Date.now()};
  t.handleSourceEvent(show);t.handleSourceEvent(show);assert.equal(store.notifications.length,1);
  t.handleSourceEvent({...show,instance:'2',summary:'Updated'});assert.equal(store.notifications.length,1);
  t.handleSourceEvent({...show,closed:true});assert.equal(store.notifications[0].nativeActive,true);
  t.handleSourceEvent({...show,instance:'2',closed:true});assert.equal(store.notifications[0].nativeActive,false);
});
test('unpinning hides the indicator but keeps the feed card',()=>{
  const {t,store}=harness();
  store.notifications=[];store.dismissIds={};store.unpinnedIds={};
  const mk=(id,age)=>({id,service:'github',sourceId:'g',account:'GitHub',summary:'T'+id,detail:'',url:'',ts:Date.now()-age,githubTimeKnown:false,githubVerified:true,seen:false,kind:'alert'});
  store.notifications=[mk('a',2000),mk('b',1000)];
  assert.equal(t.currentPinnedNotification().id,'b');
  assert.equal(t.unpinFromIndicator(),true);
  assert.equal(t.currentPinnedNotification().id,'a');
  assert.ok(store.notifications.some(n=>n.id==='b'));
  assert.equal(t.unpinFromIndicator(),true);
  assert.equal(t.currentPinnedNotification(),null);
  assert.equal(t.unpinFromIndicator(),false);
  store.notifications.push(mk('c',0));
  assert.equal(t.currentPinnedNotification().id,'c');
  const saved=t.serialize();
  assert.ok(saved.unpinnedIds.b && saved.unpinnedIds.a);
  store.unpinnedIds.stale=Date.now()-31*24*60*60*1000;
  t.prune();
  assert.ok(!('stale' in store.unpinnedIds) && store.unpinnedIds.b);
});
test('iCal subscriptions validate, deduplicate and persist',()=>{
  const {t,store}=harness();
  store.connections=[];store.dismissIds={};store.unpinnedIds={};
  assert.throws(()=>t.addICalConnection('http://insecure/cal.ics'),/https/);
  const c=t.addICalConnection('https://example.com/cal/basic.ics');
  assert.equal(c.service,'calendar');assert.equal(c.ical,true);
  assert.equal(t.addICalConnection('https://example.com/cal/basic.ics').id,c.id);
  const saved=t.serialize();
  assert.ok(saved.connections.some(x=>x.id===c.id && x.ical));
});
test('v1 migration preserves connections and manual games, clears synthetic Calendar cards, and revalidates saved mail',async()=>{
  const {t,store,window}=harness();
  window.disk={v:1,connections:[{id:'mail',service:'gmail',containerId:3,openedMail:{thread:'fingerprint'},baseline:['thread'],baselineFp:{thread:'fingerprint'}}],notifications:[{id:'mail-card',service:'gmail',sourceId:'mail',summary:'Mail',mailVerified:true,mailTimeKnown:true,ts:50},{id:'old-calendar',service:'calendar',summary:'Event from DOM',ts:Date.now()}],followedGames:{manual:{sourceId:'game-tab',manual:true}},dismissIds:{dismissed:Date.now()}};
  t.loadStore();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(store.connections[0].containerId,3);assert.equal(store.connections[0].openedMail.thread,'fingerprint');assert.equal(store.notifications.length,1);assert.equal(store.notifications[0].mailVerified,false);assert.equal(store.followedGames.manual.manual,true);assert.ok(store.dismissIds.dismissed);
  store.followedTeams={'espn:nfl:23':{id:'23',league:'nfl',paused:true}};
  const saved=t.serialize();assert.equal(saved.v,2);assert.equal(saved.followedTeams['espn:nfl:23'].paused,true);assert.equal(saved.connections[0].baseline[0],'thread');
  window.disk={...saved,notifications:[{...saved.notifications[0],ts:0,mailTimeKnown:false,mailDate:'Unknown date'}]};
  t.loadStore();await new Promise(resolve=>setImmediate(resolve));assert.equal(store.notifications[0].ts,0);
});
