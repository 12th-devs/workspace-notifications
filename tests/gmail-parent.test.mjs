import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.JSWindowActorParent=class {};
const {WorkspaceNotificationsParent}=await import('../WorkspaceNotificationsParent.sys.mjs');
function fixture(allowed=true){
  let parsed=0;
  const win={PrivateBrowsingUtils:{isWindowPrivate:()=>false},WorkspaceNotificationsStore:{canParseGmailAtom:(data)=>allowed && data.sourceId==='paired'},DOMParser:class {parseFromString(){parsed++;return {documentElement:{localName:'feed',getElementsByTagNameNS:()=>[{textContent:'0'}]},querySelector:()=>null,getElementsByTagNameNS:()=>[]};}}};
  const parent=new WorkspaceNotificationsParent();parent.browsingContext={top:{embedderElement:{ownerGlobal:win,currentURI:{spec:'https://mail.google.com/mail/u/2/'}}}};
  const request={name:'WorkspaceNotifications:ParseGmailAtom',data:{sourceId:'paired',service:'gmail',xml:'<feed />'}};
  return {parent,request,parsed:()=>parsed};
}
test('Gmail feed parsing runs in the owning chrome window',()=>{
  const f=fixture();const result=f.parent.receiveMessage(f.request);assert.equal(result.ready,true);assert.equal(result.meta.mode,'atom');assert.equal(f.parsed(),1);
});
test('unpaired and oversized Atom parser queries are rejected before parsing',()=>{
  const denied=fixture(false);assert.ok(denied.parent.receiveMessage(denied.request).error);assert.equal(denied.parsed(),0);
  const large=fixture();large.request.data.xml='x'.repeat(500001);assert.ok(large.parent.receiveMessage(large.request).error);assert.equal(large.parsed(),0);
});
