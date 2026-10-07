import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceCoordinator} from '../NotificationSources.sys.mjs';
import {nativeServiceForURL,matchesNativeSource} from '../NotificationApps.sys.mjs';

test('native app routing only accepts HTTPS supported hosts and binds origin/container',()=>{
  for(const [url,service] of [['https://app.slack.com/client/one','slack'],['https://work.slack.com','slack'],['https://teams.cloud.microsoft','teams'],['https://discord.com/channels/@me','discord'],['https://outlook.live.com/mail/0','outlook']])assert.equal(nativeServiceForURL(url),service);
  for(const url of ['http://discord.com','https://discord.com.evil.test','https://evil.test/slack.com','not a url'])assert.equal(nativeServiceForURL(url),null);
  const source={service:'slack',url:'https://one.slack.com/client',containerId:2};
  assert.equal(matchesNativeSource(source,'https://one.slack.com',2),true);
  assert.equal(matchesNativeSource(source,'https://two.slack.com',2),false);
  assert.equal(matchesNativeSource(source,'https://one.slack.com',0),false);
  assert.equal(matchesNativeSource({...source,paused:true},'https://one.slack.com',2),false);
});

test('native apps capture only connected alerts and provide a labeled inbox test',()=>{
  const e=environment();e.state.connections=[{id:'slack',service:'slack',url:'https://app.slack.com/client',containerId:2}];e.coordinator.sync();
  const alert=(origin,container,priv=0)=>({QueryInterface(){return this;},principal:{URI:{prePath:origin},origin,originAttributes:{userContextId:container,privateBrowsingId:priv}},id:'alert',countId:1,title:'A message',text:'Body'});
  e.coordinator.observe(alert('https://app.slack.com',2),'web-notification-shown');
  assert.equal(e.events[0].type,'native');assert.equal(e.events[0].sourceId,'slack');
  e.coordinator.observe(alert('https://other.slack.com',2),'web-notification-shown');
  e.coordinator.observe(alert('https://app.slack.com',0),'web-notification-shown');
  e.coordinator.observe(alert('https://app.slack.com',2,1),'web-notification-shown');assert.equal(e.events.length,1);
  assert.equal(e.coordinator.sendTestReminder('slack'),true);assert.equal(e.events.at(-1).summary,'Test alert');
  e.state.enabled=false;assert.equal(e.coordinator.sendTestReminder('slack'),false);e.detach();
});

test('iCal-only sources still poll when native alert capture is unsupported',async()=>{
  const e=environment();Services.prefs.getPrefType=()=>0;
  e.state.connections=[{id:'ical',service:'calendar',ical:true,url:'https://example.com/cal.ics'}];
  let count=0;e.window.fetch=async()=>{count++;return {ok:true,text:async()=> 'BEGIN:VCALENDAR\nEND:VCALENDAR'};};
  e.coordinator.sync();await new Promise(r=>setImmediate(r));
  assert.equal(count,1);assert.equal(e.coordinator.capture,false);e.detach();
});

test('invalid iCal responses retain alerts and offline reminders expire on time',async()=>{
  const e=environment(),c=e.coordinator;
  e.state.connections=[{id:'ical',service:'calendar',ical:true,url:'https://example.com/cal.ics'}];
  const ev={key:'old',type:'calendar',sourceId:'ical',instance:'1',summary:'Event',endTs:Date.now()+60000};
  c.ical.set('ical',{due:0,count:0,keys:new Map([['old',ev]])});
  e.window.fetch=async()=>({ok:true,text:async()=>'<html>Sign in</html>'});
  await c.tick();assert.equal(c.ical.get('ical').keys.size,1);assert.ok(e.events.some(x=>x.type==='providerStatus' && /did not return/.test(x.status)));
  ev.endTs=Date.now()-1;await c.tick();assert.equal(c.ical.get('ical').keys.size,0);assert.ok(e.events.some(x=>x.closed && x.key==='old'));e.detach();
});

test('disconnecting during an iCal fetch cannot resurrect source state or alerts',async()=>{
  const e=environment(),c=e.coordinator;let resolve;
  e.state.connections=[{id:'ical',service:'calendar',ical:true,url:'https://example.com/cal.ics'}];
  e.window.fetch=()=>new Promise(r=>resolve=r);
  const pending=c.tick();e.state.connections=[];c.sync();resolve({ok:true,text:async()=> 'BEGIN:VCALENDAR\nEND:VCALENDAR'});await pending;
  assert.equal(c.ical.size,0);assert.equal(e.events.length,0);e.detach();
});

test('manual sports refresh bypasses cached scoreboards and error backoff',()=>{
  const e=environment(),c=e.coordinator,url=c.endpoint('nfl','scoreboard');
  c.cache.set(url,{at:Date.now(),data:{events:[]}});c.failures.set(url,{due:Date.now()+60000});
  c.refresh('nfl');assert.equal(c.cache.has(url),false);assert.equal(c.failures.has(url),false);e.detach();
});

test('malformed schedule responses do not replace a cached schedule',async()=>{
  const e=environment(),c=e.coordinator;
  const key='espn:nfl:23',games=[{id:'keep',startTs:Date.now()}];
  e.state.followedTeams[key]={id:'23',league:'nfl',schedule:games};c.schedules.set(key,{at:0,games});
  e.window.fetch=async()=>({ok:true,json:async()=>({error:'unavailable'})});
  await c.tick();assert.equal(c.schedules.get(key).games,games);assert.ok(e.events.some(x=>x.stage==='schedule' && /Unavailable/.test(x.status)));e.detach();
});

function environment() {
  const observers=new Map(),values=new Map([['browser.alerts.capture.enabled',false]]),events=[];
  globalThis.Ci={nsIAlertNotification:{}};
  globalThis.Services={prefs:{PREF_BOOL:128,getPrefType:()=>128,prefHasUserValue:()=>false,getBoolPref:p=>values.get(p),setBoolPref:(p,v)=>{values.set(p,v);observers.get(p)?.observe();},clearUserPref:p=>{values.set(p,false);},addObserver:(p,o)=>observers.set(p,o),removeObserver:p=>observers.delete(p)},obs:{addObserver:(p,t)=>observers.set(t,p),removeObserver:(p,t)=>observers.delete(t)}};
  const state={connections:[],followedTeams:{},enabled:true},window={setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout,AbortController,fetch:async()=>({ok:true,json:async()=>({events:[]})})};
  const coordinator=new SourceCoordinator(),detach=coordinator.attach({window,getState:()=>state,onEvent:e=>events.push(e)});
  return {coordinator,state,window,events,observers,values,detach};
}
test('Calendar subscribes once, filters origin/container/private/paused and restores capture preference',()=>{
  const e=environment(),{coordinator:c,state,events,values}=e;
  state.connections=[{id:'cal',service:'calendar',containerId:2,paused:false}];c.sync();c.sync();assert.equal(values.get('browser.alerts.capture.enabled'),true);
  const alert=(origin='https://calendar.google.com',container=2,priv=0)=>({QueryInterface(){return this;},principal:{URI:{prePath:origin},origin:origin+'^userContextId='+container,originAttributes:{userContextId:container,privateBrowsingId:priv}},id:'tag',countId:5,title:'Reminder',text:'Body'});
  c.observe(alert(),'web-notification-shown');c.observe(alert(),'web-notification-closed');assert.equal(events.filter(e=>e.type==='calendar').length,2);
  c.observe(alert('https://mail.google.com'),'web-notification-shown');c.observe(alert(undefined,3),'web-notification-shown');c.observe(alert(undefined,2,1),'web-notification-shown');assert.equal(events.length,2);
  state.connections[0].paused=true;c.sync();c.observe(alert(),'web-notification-shown');assert.equal(events.length,2);assert.equal(values.get('browser.alerts.capture.enabled'),false);
  e.detach();
});
test('calendar counts every captured alert and self-test proves the feed path',()=>{
  const e=environment(),{coordinator:c,state,events}=e;
  state.connections=[{id:'cal',service:'calendar',containerId:2,paused:false}];c.sync();
  const other=()=>({QueryInterface(){return this;},principal:{URI:{prePath:'https://example.com'},origin:'https://example.com',originAttributes:{userContextId:0}},id:'x',countId:1,title:'Other',text:'Body'});
  c.observe(other(),'web-notification-shown');
  assert.equal(events.length,0);
  assert.equal(c.diagnostics().alertsSeen,1);
  assert.equal(c.diagnostics().lastAlertOrigin,'https://example.com');
  assert.ok(c.sendTestReminder('cal'));
  assert.equal(events.filter(e=>e.type==='calendar' && !e.closed).length,1);
  assert.equal(events.at(-1).summary,'Test reminder');
  assert.equal(c.sendTestReminder('missing'),false);
  state.connections[0].paused=true;
  assert.equal(c.sendTestReminder('cal'),false);
  e.detach();
});
test('iCal feeds surface upcoming events and close them when over',async()=>{
  const e=environment(),{coordinator:c,state,events}=e;
  const stamp=d=>{const p=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;};
  const icsFor=starts=>['BEGIN:VCALENDAR',...starts.map((s,i)=>['BEGIN:VEVENT',`UID:ev-${i}`,`DTSTART:${stamp(s)}`,`DTEND:${stamp(new Date(s.getTime()+30*60000))}`,`SUMMARY:Event ${i}`,'END:VEVENT'].join('\r\n')),'END:VCALENDAR'].join('\r\n');
  state.connections=[{id:'ical1',service:'calendar',ical:true,url:'https://example.com/cal.ics',paused:false}];
  const start=new Date(Date.now()+10*60*1000);
  e.window.fetch=async()=>({ok:true,text:async()=>icsFor([start])});
  await c.tick();
  const opens=events.filter(x=>x.type==='calendar' && !x.closed);
  assert.equal(opens.length,1);assert.equal(opens[0].sourceId,'ical1');assert.equal(opens[0].summary,'Event 0');
  assert.ok(events.some(x=>x.type==='providerStatus' && x.key==='ical1' && x.status.startsWith('Monitoring')));
  c.ical.get('ical1').due=0;await c.tick();
  assert.equal(events.filter(x=>x.type==='calendar' && !x.closed).length,1);
  c.ical.get('ical1').due=0;e.window.fetch=async()=>({ok:true,text:async()=>icsFor([])});
  await c.tick();
  assert.ok(events.some(x=>x.type==='calendar' && x.closed));
  c.ical.get('ical1').due=0;e.window.fetch=async()=>{throw Error('offline');};
  await c.tick();
  assert.ok(events.some(x=>x.type==='providerStatus' && /Unavailable/.test(x.status)));
  state.connections[0].paused=true;c.sync();
  assert.ok(!c.ical.has('ical1'));
  e.detach();
});
test('a preference changed by another consumer is not restored',()=>{
  const e=environment();e.state.connections=[{id:'cal',service:'calendar'}];e.coordinator.sync();Services.prefs.setBoolPref('browser.alerts.capture.enabled',false);e.state.connections=[];e.coordinator.sync();assert.equal(e.values.get('browser.alerts.capture.enabled'),false);e.detach();
});
test('two windows share one in-flight request and successful cache',async()=>{
  const e=environment();let requests=0,resolve;e.window.fetch=()=>{requests++;return new Promise(r=>resolve=r);};
  const detachSecond=e.coordinator.attach({window:e.window,getState:()=>e.state,onEvent(){}});
  const a=e.coordinator.request('https://example.com/data',60000),b=e.coordinator.request('https://example.com/data',60000);
  resolve({ok:true,json:async()=>({value:1})});assert.deepEqual(await a,await b);await e.coordinator.request('https://example.com/data',60000);assert.equal(requests,1);
  e.detach();assert.equal(e.coordinator.clients.size,1);detachSecond();assert.equal(e.coordinator.clients.size,0);
});
test('provider errors back off, retain follows, and avoid duplicate requests',async()=>{
  const e=environment();let count=0;e.window.fetch=async()=>{count++;throw Error('offline');};
  e.state.followedTeams.test={id:'23',league:'nfl'};
  await assert.rejects(e.coordinator.request('https://example.com/error'),/offline/);
  await assert.rejects(e.coordinator.request('https://example.com/error'),/Retrying/);
  assert.equal(count,1);assert.equal(Object.keys(e.state.followedTeams).length,1);assert.ok(e.coordinator.failures.get('https://example.com/error').due>Date.now());e.detach();
});
