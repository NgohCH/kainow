import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLeaveGuard } from './leaveGuard.ts';

function setup(answers: boolean[]) {
  const env = { hash: '#/a', asked: 0, restored: [] as string[] };
  const guard = createLeaveGuard({
    confirm: () => {
      env.asked++;
      return answers.shift() ?? false;
    },
    hash: () => env.hash,
    restore: (h) => {
      env.restored.push(h);
      env.hash = h;
    },
  });
  return { env, guard };
}
const hashEvent = () => ({ stopped: false, stopImmediatePropagation() { this.stopped = true; } });
const click = (href: string, over: Record<string, unknown> = {}) => ({
  defaultPrevented: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, prevented: false,
  link: { href, target: '' },
  preventDefault() { this.prevented = true; },
  ...over,
});
const unload = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('with nothing unsaved, nobody is asked', () => {
  const { env, guard } = setup([]);
  env.hash = '#/b';
  const e = hashEvent();
  guard.onHashChange(e);
  const u = unload();
  guard.onUnload(u);
  assert.deepEqual([env.asked, e.stopped, u.prevented], [0, false, false]);
  assert.equal(guard.mayLeave(), true);
});

test('going elsewhere asks; staying puts the address back and hides the change from the rest of the app', () => {
  const { env, guard } = setup([false]);
  guard.arm('Unsaved');
  env.hash = '#/b';
  const e = hashEvent();
  guard.onHashChange(e);
  assert.equal(e.stopped, true);
  assert.deepEqual(env.restored, ['#/a']);
  assert.equal(guard.mayLeave(), false, 'still armed');
});

test('leaving on purpose asks once', () => {
  const { env, guard } = setup([true]);
  guard.arm('Unsaved');
  const c = click('#/b');
  guard.onClick(c, c.link);
  assert.equal(c.prevented, false);
  env.hash = '#/b';
  const e = hashEvent();
  guard.onHashChange(e);
  assert.deepEqual([env.asked, e.stopped], [1, false]);
});

test('a link is stopped before it moves; one to this page, another tab, another site or handled by the page is not asked about', () => {
  const { env, guard } = setup([false]);
  guard.arm('Unsaved');
  const c = click('#/b');
  guard.onClick(c, c.link);
  assert.equal(c.prevented, true);
  for (const x of [click('#/a'), click('#/b', { ctrlKey: true }), click('#/b', { defaultPrevented: true }), click('https://example.org/'), click('#/b', { link: { href: '#/b', target: '_blank' } })]) guard.onClick(x, x.link);
  guard.onClick(click('#/b'), null);
  assert.equal(env.asked, 1);
});

test('closing the tab is warned about, and no longer once the input is saved', () => {
  const { guard } = setup([]);
  const disarm = guard.arm('Unsaved');
  const u = unload();
  guard.onUnload(u);
  assert.equal(u.prevented, true);
  disarm();
  const v = unload();
  guard.onUnload(v);
  assert.equal(v.prevented, false);
});

test('two forms with unsaved input: one being saved leaves the other guarded', () => {
  const { guard } = setup([false]);
  const one = guard.arm('One');
  guard.arm('Two');
  one();
  one();
  assert.equal(guard.mayLeave(), false);
});
