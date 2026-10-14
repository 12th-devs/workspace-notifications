// Own only our toast; Zen and Tidy Downloads keep control of their siblings.
export class NotificationPopups {
  constructor(window,{canShow=()=>true,onOpen=()=>{}}={}) {
    this.window=window; this.canShow=canShow; this.onOpen=onOpen;
    this.queue=[]; this.seen=new Set(); this.active=null; this.retry=null; this.destroyed=false;
  }
  show(payload) {
    if(this.destroyed || !this.canShow() || !payload?.title || this.seen.has(payload.id)) return false;
    this.seen.add(payload.id);
    if(this.seen.size>200) this.seen.delete(this.seen.values().next().value);
    // Score bursts for the same game keep the latest pending score. Period and
    // game boundaries keep separate queue entries so a score cannot erase them.
    const index=payload.coalesceKey ? this.queue.findIndex(p=>p.coalesceKey===payload.coalesceKey) : -1;
    if(index>=0) this.queue[index]=payload;
    else {this.queue.push(payload);if(this.queue.length>20)this.queue.shift();}
    this.pump(); return true;
  }
  pump() {
    if(this.destroyed || this.active || this.retry!=null) return;
    if(!this.canShow()) {this.queue=[];return;}
    while(this.queue.length && this.queue[0].isCurrent?.()===false) this.queue.shift();
    if(!this.queue.length) return;
    const win=this.window,doc=win.document,container=doc.getElementById('zen-toast-container');
    if(!container || container.children.length) {
      this.retry=win.setTimeout(()=>{this.retry=null;this.pump();},250);return;
    }
    const payload=this.queue.shift(),wrapper=doc.createXULElement('hbox');
    wrapper.classList.add('zen-toast','wn-toast');wrapper.setAttribute('role','status');wrapper.setAttribute('aria-live','polite');
    const content=doc.createElement('div');content.className='wn-toast-content';content.setAttribute('role','button');content.tabIndex=0;
    content.setAttribute('aria-label',payload.title+'. Open notification inbox');
    const title=doc.createElement('div');title.className='wn-toast-title';title.textContent=String(payload.title).slice(0,360);
    content.append(title);
    // Match ZenToasts' icon-only XUL action and native footer-button styling.
    const action=doc.createXULElement('button');action.classList.add('footer-button','primary','wn-toast-action');
    action.setAttribute('image','chrome://browser/skin/zen-icons/share.svg');action.setAttribute('aria-label','Open notification inbox');action.setAttribute('tooltiptext','Open notification inbox');
    wrapper.setAttribute('button','true');
    wrapper.append(content,action);container.removeAttribute('hidden');container.append(wrapper);
    let timer=null,guard=null,dismissed=false,finished=false;
    const finish=()=>{
      if(finished)return;finished=true;win.clearTimeout(guard);wrapper.remove();
      if(!container.children.length)container.setAttribute('hidden','true');
      this.active=null;if(!this.destroyed)this.pump();
    };
    const reduced=()=>win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const animate=(frames,options)=>{
      try {if(!reduced() && win.gZenUIManager?.motion)return win.gZenUIManager.motion.animate(wrapper,frames,options);}catch(_e){}
      return null;
    };
    const dismiss=(immediate=false)=>{
      if(dismissed){if(immediate)finish();return;}dismissed=true;win.clearTimeout(timer);
      if(immediate){finish();return;}
      const animation=animate({opacity:[1,0],scale:[1,.5]},{duration:.2,bounce:0});
      if(animation){guard=win.setTimeout(finish,400);Promise.resolve(animation).then(finish,finish);}else finish();
    };
    const pause=()=>win.clearTimeout(timer);
    const resume=()=>{pause();if(!dismissed)timer=win.setTimeout(()=>dismiss(),5000);};
    const open=()=>{dismiss();if(this.canShow() && payload.isCurrent?.()!==false)this.onOpen(payload);};
    content.addEventListener('click',open);
    content.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
    action.addEventListener('command',open);
    wrapper.addEventListener('mouseenter',pause);
    wrapper.addEventListener('mouseleave',()=>{if(!wrapper.contains(doc.activeElement))resume();});
    wrapper.addEventListener('focusin',pause);
    wrapper.addEventListener('focusout',e=>{if(!wrapper.contains(e.relatedTarget) && !wrapper.matches(':hover'))resume();});
    wrapper.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();dismiss();}});
    this.active={wrapper,dismiss};
    const entrance=animate({scale:[.8,1],opacity:[0,1]},{type:'spring',bounce:.2,duration:.5});
    if(entrance)Promise.resolve(entrance).catch(()=>{wrapper.style.transform='scale(1)';wrapper.style.opacity='1';});
    resume();
  }
  clear() {
    this.queue=[];this.window.clearTimeout(this.retry);this.retry=null;this.active?.dismiss(true);
  }
  destroy() {
    this.destroyed=true;this.seen.clear();this.clear();
  }
}
