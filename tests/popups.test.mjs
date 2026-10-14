import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NotificationPopups} from '../NotificationPopups.sys.mjs';

class Element {
  constructor(tag) {this.tag=tag;this.children=[];this.attrs={};this.style={};this.events={};this.classList={add:(...s)=>this.classes=s};}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  setAttribute(k,v){this.attrs[k]=v;} removeAttribute(k){delete this.attrs[k];}
  addEventListener(k,fn){this.events[k]=fn;}
  contains(n){return n===this || this.children.some(c=>c.contains(n));}
  matches(){return false;}
}
function fixture() {
  const container=new Element('container'),timers=new Map();let now=0,next=0,allowed=true,opened=0;
  const document={getElementById:()=>container,createXULElement:t=>new Element(t),createElement:t=>new Element(t),activeElement:null};
  const window={document,setTimeout(fn,ms){const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);},matchMedia:()=>({matches:false})};
  const popups=new NotificationPopups(window,{canShow:()=>allowed,onOpen:()=>opened++});
  const tick=ms=>{const end=now+ms;while(true){const item=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!item || item[1].at>end)break;now=item[1].at;timers.delete(item[0]);item[1].fn();}now=end;};
  const show=(id,extra={})=>popups.show({id,title:'Notification '+id,destination:'GitHub · Workspace notifications → Inbox',...extra});
  return {popups,container,window,tick,show,timers,setAllowed:v=>allowed=v,opened:()=>opened};
}
test('popups use native Zen toast children, literal title/destination and one visible popup',()=>{
  const f=fixture();f.show('one',{title:'<b>Literal</b>'});f.show('two');assert.equal(f.container.children.length,1);
  const wrapper=f.container.children[0];assert.deepEqual(wrapper.classes,['zen-toast','wn-toast']);assert.equal(wrapper.attrs.role,'status');
  assert.equal(wrapper.children[0].children[0].textContent,'<b>Literal</b>');assert.equal(wrapper.children[0].children.length,1);assert.equal(wrapper.children[1].tag,'button');assert.equal(wrapper.children.length,2);assert.deepEqual(wrapper.children[1].classes,['footer-button','primary','wn-toast-action']);assert.equal(wrapper.children[1].attrs.image,'chrome://browser/skin/zen-icons/share.svg');assert.equal(wrapper.attrs.button,'true');
  f.tick(5000);assert.equal(f.container.children.length,1);assert.match(f.container.children[0].children[0].children[0].textContent,/two/);
  f.tick(5000);assert.equal(f.container.children.length,0);assert.equal(f.container.attrs.hidden,'true');
});
test('Zen/Tidy sibling popups remain untouched while our queue waits',()=>{
  const f=fixture(),native=new Element('native');f.container.append(native);f.show('ours');f.tick(1000);
  assert.equal(f.container.children[0],native);assert.equal(f.popups.active,null);
  native.remove();f.tick(250);assert.equal(f.container.children[0].classes[1],'wn-toast');f.popups.destroy();
});
test('duplicate deliveries are ignored, score bursts coalesce but quarter boundaries survive',()=>{
  const f=fixture();f.show('active');f.show('active');f.show('score1',{coalesceKey:'game'});f.show('quarter');f.show('score2',{coalesceKey:'game'});
  assert.deepEqual(f.popups.queue.map(p=>p.id),['score2','quarter']);f.popups.destroy();
});
test('hover/focus pause dismissal, keyboard opens the inbox and Escape dismisses without clearing notifications',()=>{
  const f=fixture();f.show('one');const wrapper=f.popups.active.wrapper,content=wrapper.children[0];
  wrapper.events.mouseenter();f.tick(6000);assert.equal(f.container.children.length,1);
  wrapper.events.mouseleave();f.tick(1000);wrapper.events.focusin();f.tick(6000);assert.equal(f.container.children.length,1);
  let prevented=false;content.events.keydown({key:'Enter',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(f.opened(),1);assert.equal(f.container.children.length,0);
  f.show('two');f.popups.active.wrapper.events.keydown({key:'Escape',stopPropagation(){}});assert.equal(f.container.children.length,0);
});
test('paused/disconnected sources and disabled popups drop queued alerts',()=>{
  const f=fixture();f.show('active');f.show('stale',{isCurrent:()=>false});f.tick(5000);assert.equal(f.container.children.length,0);
  f.show('next');f.show('queued');f.setAllowed(false);f.tick(5000);assert.equal(f.popups.queue.length,0);assert.equal(f.show('disabled'),false);
});
test('animation rejection falls back to removal; reduced motion avoids Zen motion',async()=>{
  const f=fixture();let animations=0;f.window.gZenUIManager={motion:{animate(){animations++;return Promise.reject(Error('unavailable'));}}};
  f.show('one');await Promise.resolve();f.tick(5000);await Promise.resolve();assert.equal(f.container.children.length,0);
  f.window.matchMedia=()=>({matches:true});const before=animations;f.show('two');f.tick(5000);assert.equal(animations,before);
});
test('unload cancels our timers and removes only our toast',()=>{
  const f=fixture();f.show('one');const sibling=new Element('native');f.container.append(sibling);f.show('pending');f.popups.destroy();f.tick(10000);
  assert.deepEqual(f.container.children,[sibling]);assert.equal(f.popups.queue.length,0);assert.equal(f.timers.size,0);assert.equal(f.show('late'),false);
});

test('native icon action opens the inbox with no dismiss button',()=>{
  const f=fixture();f.show('open');const wrapper=f.popups.active.wrapper;assert.equal(wrapper.children.length,2);wrapper.children[1].events.command();assert.equal(f.opened(),1);assert.equal(f.container.children.length,0);
});
