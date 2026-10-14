import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {NATIVE_APPS} from '../NotificationApps.sys.mjs';
class Node {
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.className='';this.textContent='';this.classList={add:()=>{},toggle:()=>{}};}
  append(...nodes){this.children.push(...nodes);} appendChild(node){this.append(node);return node;}
  setAttribute(k,v){this.attrs[k]=String(v);} insertBefore(node,before){this.children.splice(this.children.indexOf(before),0,node);}
}
function all(node){return [node,...node.children.flatMap(all)];}
function setup(view){
  const source=readFileSync(new URL('../workspace-notifications.uc.js',import.meta.url),'utf8');
  const render=source.match(/  function renderSourcesPanel\(\) \{[\s\S]*?\n  \}/)[0];
  const identity=source.match(/  function connectionIdentity\(service,value,container\) \{[\s\S]*?\n  \}/)[0];
  const account={id:'paired',service:view,label:'Account',accountLabel:'reader@example.com',url:view==='gmail'?'https://mail.google.com/mail/u/0/':'https://github.com',containerId:0};
  const context={sourceView:view,sourceDetailId:'',sourceReturnView:'apps',accountPairing:false,teamReturnView:'teams',NativeApps:NATIVE_APPS,NATIVE_SERVICES:new Set(Object.keys(NATIVE_APPS)),SERVICE_LABEL:{gmail:'Mail',github:'GitHub',slack:'Slack'},store:{connections:[account]},document:{createElement:t=>new Node(t)},feedPanel:{classList:{add(){}},querySelector:()=>null},wnIcon:()=>new Node('span'),appBrandIcon:()=>new Node('img'),appIcon:()=>new Node('img'),connStatusText:()=> 'Monitoring',findTabBySourceId:()=>null,connForSourceId:id=>id==='paired'?account:null,renderAll(){},broadcast(){},Sources:{},validHttpsUrl:u=>u,eligibleTabs:()=>[{service:view,url:account.url,title:'Same session',containerId:0},{service:view,url:view==='gmail'?'https://mail.google.com/mail/u/1/':account.url,title:'Another account',containerId:view==='gmail'?0:2}],connectTab:e=>context.connected=e};
  context.commitPanel=(node,key)=>{context.root=node;context.key=key;};
  vm.createContext(context);vm.runInContext(identity+'\n'+render,context);context.renderSourcesPanel();return context;
}
for(const service of ['gmail','github'])test(service+' paired-account list adds accounts and keeps icon-only back in the header',()=>{
  const c=setup(service),nodes=all(c.root);assert.ok(nodes.some(n=>n.textContent==='reader@example.com'));
  const titleRow=nodes.find(n=>n.className==='wn-main-titlerow');assert.equal(titleRow.children[0].className,'wn-header-back');assert.equal(titleRow.children[0].textContent,'');assert.equal(titleRow.children[1].className,'wn-main-head');
  nodes.find(n=>n.textContent==='Add account').onclick({stopPropagation(){}});assert.equal(c.accountPairing,true);
  const chooser=all(c.root);assert.equal(chooser.filter(n=>n.textContent==='Pair account').length,1);assert.ok(!chooser.some(n=>n.textContent==='Same session'));
  chooser.find(n=>n.textContent==='Pair account').onclick({stopPropagation(){}});assert.equal(c.connected.title,'Another account');assert.equal(c.accountPairing,false);assert.equal(c.sourceView,service);
  all(c.root).find(n=>n.className==='wn-chev').onclick({stopPropagation(){}});assert.equal(c.sourceView,'app');assert.equal(c.sourceReturnView,service);
  all(c.root).find(n=>n.className==='wn-header-back').onclick({stopPropagation(){}});assert.equal(c.sourceView,service);
});

test('desktop-alert services expose paired connections and their add flow',()=>{
  const c=setup('slack');assert.ok(all(c.root).some(n=>n.textContent==='Paired connections (1)'));
  all(c.root).find(n=>n.textContent==='Add account').onclick({stopPropagation(){}});
  assert.ok(all(c.root).some(n=>n.textContent==='Pair connection'));
  all(c.root).find(n=>n.className==='wn-header-back').onclick({stopPropagation(){}});assert.equal(c.accountPairing,false);assert.equal(c.sourceView,'slack');
});
