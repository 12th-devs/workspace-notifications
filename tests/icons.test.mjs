import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {gameScoreStatus} from '../NotificationGameEvents.sys.mjs';

// Structural checks for the icon pipeline without a browser DOM.
function fakeEl(tag) {
  return {
    tag, attrs: {}, children: [],
    classList: {_s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); }},
    dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    append(...nodes) {this.children.push(...nodes);},
  };
}

function load() {
  const src = readFileSync(new URL('../workspace-notifications.uc.js', import.meta.url), 'utf8');
  const tabler = src.match(/function tablerCalendarClock\(\) \{[\s\S]*?\n  \}/);
  const appIcon = src.match(/function appIcon\(source\) \{[\s\S]*?\n  \}/);
  assert.ok(tabler && appIcon, 'icon functions present in source');
  const sandbox = {
    document: {
      createElementNS: (_ns, t) => fakeEl(t),
      createElement: (t) => fakeEl(t),
    },
    connForSourceId: (id) => (id === 'ical1' ? {id, ical: true} : null),
    findTabBySourceId: () => null,
    nativeIconUrl: (v) => v || '',
    validHttpsUrl: (u) => u,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(tabler[0] + '\n' + appIcon[0], sandbox);
  return sandbox;
}

test('iCal sources resolve to the inline Tabler calendar-clock glyph',() => {
  const {tablerCalendarClock, appIcon} = load();
  const svg = tablerCalendarClock();
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs.viewBox, '0 0 24 24');
  assert.equal(svg.attrs.stroke, 'currentColor');
  assert.equal(svg.children.length, 6);
  assert.ok(svg.classList.contains('wn-app-icon'));
  assert.equal(svg.dataset.wnSrc, 'tabler:calendar-clock');
  const viaApp = appIcon({sourceId: 'ical1'});
  assert.equal(viaApp.tag, 'svg');
  assert.equal(viaApp.dataset.wnSrc, 'tabler:calendar-clock');
});

test('tabbed sources still resolve to favicon images',() => {
  const {appIcon} = load();
  const img = appIcon({sourceId: 'missing', url: 'https://example.com/app'});
  assert.equal(img.tag, 'img');
  assert.equal(img.src, 'page-icon:https://example.com/app');
});

test('the shared score renderer puts the reported clock directly beneath the score',()=>{
  const src=readFileSync(new URL('../workspace-notifications.uc.js',import.meta.url),'utf8');
  const render=src.match(/function scoreBoard\(g\) \{[\s\S]*?\n  \}/)[0];
  const sandbox={document:{createElement:fakeEl},teamIconUrl:()=>'',gameScoreStatus,scoreText:()=> 'Steelers 24 – 27 Browns · Q3 ● 9:47'};
  vm.createContext(sandbox);vm.runInContext(render,sandbox);
  const board=sandbox.scoreBoard({away:'Steelers',home:'Browns',awayScore:'24',homeScore:'27',period:3,displayClock:'9:47',sport:'football'});
  const center=board.children[1];assert.equal(center.className,'wn-score-center');assert.equal(center.children[0].children[0].className,'wn-score-away');assert.equal(center.children[0].children[0].textContent,'24');assert.equal(center.children[0].children[1].className,'wn-score-home');assert.equal(center.children[0].children[1].textContent,'27');assert.equal(center.children[1].textContent,'Q3 ● 9:47');assert.match(board.attrs['aria-label'],/9:47/);
});


test('Apps provider logos resolve to bundled assets instead of uncached page icons',()=>{
  const src=readFileSync(new URL('../workspace-notifications.uc.js',import.meta.url),'utf8');
  const render=src.match(/function appBrandIcon\(service\) \{[\s\S]*?\n  \}/)[0];
  const sandbox={document:{createElement:fakeEl}};vm.createContext(sandbox);vm.runInContext(render,sandbox);
  for(const service of ['gmail','github','calendar','slack','teams','discord','outlook','espn']){
    const icon=sandbox.appBrandIcon(service);assert.match(icon.src,/^resource:\/\/workspace-notifications\/icons\//);
    const file=icon.src.split('/').at(-1);assert.ok(readFileSync(new URL('../icons/'+file,import.meta.url)).length>100);
  }
  assert.equal(sandbox.appBrandIcon('unknown'),null);
});
