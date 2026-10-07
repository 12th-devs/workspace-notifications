import {test} from 'node:test';
import assert from 'node:assert/strict';
globalThis.JSWindowActorChild=class {};
const {__wnTest:{scanGmail}}=await import('../WorkspaceNotificationsChild.sys.mjs');

function gmailDoc(hash,grid=false,busy=false) {
  return {location:{hash},title:'Gmail',querySelectorAll:()=>[],querySelector(selector){
    if(selector==='div[role="main"]')return {querySelector:()=>grid?{}:null};
    return busy?{}:null;
  }};
}
test('Gmail DOM fallback only establishes an empty inbox from a loaded inbox grid',()=>{
  assert.equal(scanGmail(gmailDoc('#inbox',true)).ready,true);
  assert.equal(scanGmail(gmailDoc('#inbox',true,true)).ready,false);
  assert.equal(scanGmail(gmailDoc('#inbox/message',false)).ready,false);
  assert.equal(scanGmail(gmailDoc('#sent',true)).ready,false);
  assert.equal(scanGmail(gmailDoc('#search/test',true)).ready,false);
});
