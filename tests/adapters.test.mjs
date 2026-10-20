import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.JSWindowActorChild=class {};
const {WorkspaceNotificationsChild,__wnTest:{scanGmail,detectService,gmailFeedURL,parseGmailAtom}}=await import('../WorkspaceNotificationsChild.sys.mjs');

test('Google sports search tabs are no longer connectable',()=>{
  assert.equal(detectService('https://www.google.com/search?q=nfl'),null);
  assert.equal(detectService('https://mail.google.com/mail/u/0/'),'gmail');
});

function gmailDoc(hash,grid=false,busy=false) {
  return {location:{hash},title:'Gmail',querySelectorAll:()=>[],querySelector(selector){
    if(selector==='div[role="main"]')return {querySelector:()=>grid?{}:null};
    return busy?{}:null;
  }};
}
test('Gmail read-state helper requires a loaded inbox grid',()=>{
  assert.equal(scanGmail(gmailDoc('#inbox',true)).ready,true);
  assert.equal(scanGmail(gmailDoc('#inbox',true,true)).ready,false);
  assert.equal(scanGmail(gmailDoc('#inbox/message',false)).ready,false);
  assert.equal(scanGmail(gmailDoc('#sent',true)).ready,false);
  assert.equal(scanGmail(gmailDoc('#search/test',true)).ready,false);
});


test('Gmail Atom URL follows the paired account slot and defaults to slot zero',()=>{
  assert.equal(gmailFeedURL('https://mail.google.com/mail/u/2/#inbox'),'https://mail.google.com/mail/u/2/feed/atom');
  assert.equal(gmailFeedURL('https://mail.google.com/mail/'),'https://mail.google.com/mail/u/0/feed/atom');
  assert.throws(()=>gmailFeedURL('https://example.com/mail/u/2/'),/paired Gmail/);
});
function atomFixture(){
  const doc=gmailDoc('#inbox',true);doc.defaultView={DOMParser:class {parseFromString(){return {documentElement:{localName:'feed',getElementsByTagNameNS:()=>[{textContent:'0'}]},querySelector:()=>null,getElementsByTagNameNS:()=>[]};}}};
  const actor=new WorkspaceNotificationsChild();actor._active={sourceId:'paired'};actor._diagnostic=()=>{};let calls=[];
  const chromeParser=doc.defaultView.DOMParser;
  actor.sendQuery=async(name,data)=>{assert.equal(name,'WorkspaceNotifications:ParseGmailAtom');assert.equal(data.sourceId,'paired');return parseGmailAtom(data.xml,{defaultView:{DOMParser:chromeParser}},gmailFeedURL(data.href));};
  doc.defaultView.DOMParser=class {parseFromString(){throw Error('Content CSP blocks DOMParser');}};
  actor.contentWindow={AbortController,setTimeout:()=>1,clearTimeout(){},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,url,text:async()=>'<feed />'};}};
  return {doc,actor,calls};
}
test('Gmail uses session-authenticated Atom even without an account path, with cached and forced refresh',async()=>{
  const {doc,actor,calls}=atomFixture();const href='https://mail.google.com/mail/';
  const out=await actor._gmailSnapshot(doc,href,'manual');assert.equal(out.ready,true);assert.equal(out.meta.mode,'atom');assert.equal(calls[0].url,gmailFeedURL(href));assert.equal(calls[0].options.credentials,'include');assert.equal(calls[0].options.redirect,'error');
  await actor._gmailSnapshot(doc,href,'mutation');assert.equal(calls.length,1);await actor._gmailSnapshot(doc,href,'manual');assert.equal(calls.length,2);
});
test('Atom failures preserve successful cache and never turn the rendered mailbox into an unread snapshot',async()=>{
  const {doc,actor}=atomFixture();await actor._gmailSnapshot(doc,'https://mail.google.com/mail/u/1/','manual');const cache=actor._atomCache;
  actor.contentWindow.fetch=async()=>({ok:false,status:401});const failed=await actor._gmailSnapshot(doc,'https://mail.google.com/mail/u/1/','manual');assert.equal(failed.ready,false);assert.equal(failed.signin,true);assert.equal(failed.meta.mode,'atom');assert.equal(actor._atomCache,cache);
});
test('Atom fetch suppresses the HTTP Basic auth dialog via mozBackgroundRequest',async()=>{
  const {doc,actor}=atomFixture();let seen={};
  actor.contentWindow={AbortController,setTimeout:()=>1,clearTimeout(){},XMLHttpRequest:class {
    constructor(){seen.instance=this;}
    open(m,u){seen.method=m;seen.url=u;}
    setRequestHeader(){}
    send(){this.status=401;this.responseURL=seen.url;this.responseText='';if(this.onload)this.onload();}
  }};
  const res=await actor._fetchAtomText('https://mail.google.com/mail/u/0/feed/atom',{aborted:false,addEventListener(){}});
  assert.equal(seen.instance.mozBackgroundRequest,true);
  assert.equal(res.status,401);
  actor.contentWindow={AbortController,setTimeout:()=>1,clearTimeout(){},fetch:async()=>({ok:false,status:401})};
  delete actor._atomCache;
  const failed=await actor._gmailSnapshot(doc,'https://mail.google.com/mail/u/0/','manual');
  assert.equal(failed.signin,true);
});
