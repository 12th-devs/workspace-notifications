// Parse feed XML in privileged browser chrome, outside Gmail page CSP.
const MAX_ITEMS=50;
function fnv1a(str){let h=0x811c9dc5;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193);}return ('0000000'+(h>>>0).toString(36)).slice(-8);}
function absUrl(href,base){try{return new URL(href,base).href;}catch(_e){return '';}}
function isHttpsHttpUrl(url){try{return ['http:','https:'].includes(new URL(url).protocol);}catch(_e){return false;}}

export function gmailFeedURL(href) {
  const url=new URL(href);
  if(url.protocol!=='https:' || url.hostname!=='mail.google.com')throw Error('Gmail feed requires a paired Gmail tab');
  const account=url.pathname.match(/\/mail\/u\/(\d+)(?:\/|$)/)?.[1] || '0';
  return 'https://mail.google.com/mail/u/'+account+'/feed/atom';
}

export function parseGmailAtom(xml, doc, feedUrl) {
  const feed = new doc.defaultView.DOMParser().parseFromString(xml, 'application/xml');
  if (feed.documentElement?.localName !== 'feed' || feed.querySelector('parsererror')) throw new Error('Not an Atom feed');
  const value = (node, name) => (node.getElementsByTagNameNS('*', name)[0]?.textContent || '').trim();
  const items = Array.from(feed.getElementsByTagNameNS('*', 'entry')).map((entry,sourceRank) => {
    const id = value(entry,'id'), subject = value(entry,'title') || '(No subject)';
    const sender = value(entry,'name') || value(entry,'email') || 'Unknown';
    const detail = value(entry,'summary').slice(0,200);
    const link = Array.from(entry.getElementsByTagNameNS('*','link')).find(n => !n.getAttribute('rel') || n.getAttribute('rel') === 'alternate');
    const url = absUrl(link?.getAttribute('href') || '', feedUrl);
    const date = value(entry,'issued') || value(entry,'published') || value(entry,'modified') || value(entry,'updated');
    const ts = Date.parse(date);
    return {id:'gmail:atom:'+fnv1a(id || url+'|'+subject), summary:(sender+' — '+subject).slice(0,240), detail, ts:Number.isFinite(ts) ? ts : 0, url:isHttpsHttpUrl(url) && new URL(url).hostname === 'mail.google.com' ? url : '', fingerprint:fnv1a(id+'|'+subject+'|'+detail+'|'+date), meta:{sender,subject,date,unread:true,precision:Number.isFinite(ts)?'time':'unknown',sourceRank}};
  });
  return {ready:true, items:items.sort((a,b)=>b.ts-a.ts || a.meta.sourceRank-b.meta.sourceRank).slice(0,MAX_ITEMS), meta:{mode:'atom', completeInbox:Number(value(feed.documentElement,'fullcount'))===items.length && items.length<=MAX_ITEMS, unread:value(feed.documentElement,'fullcount') ? Number(value(feed.documentElement,'fullcount')) : items.length}};
}
