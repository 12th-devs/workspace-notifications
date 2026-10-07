import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Structural checks for the icon pipeline without a browser DOM.
function fakeEl(tag) {
  return {
    tag, attrs: {}, children: [],
    classList: {_s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); }},
    dataset: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
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
