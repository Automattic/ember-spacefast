import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBody, userIdsIn, userIdFromSgid } from '../server/vendor/ember-richtext.js';

test('upstream sanitizer retains formatting and code while removing executable markup', () => {
  const prepared = prepareBody('<p><strong>hello</strong><em>there</em></p><pre>code &lt;tag&gt;</pre><script>alert(1)</script><img src=x onerror=alert(1)>', () => undefined);
  assert.ok(prepared.html.includes('<strong>hello</strong>'));
  assert.ok(prepared.html.includes('<em>there</em>'));
  assert.ok(prepared.plainText.includes('code <tag>'));
  assert.doesNotMatch(prepared.html, /script|onerror|<img/i);
});

test('unsafe and entity-obscured link protocols cannot survive', () => {
  for (const href of ['javascript:alert(1)', '&#106;avascript:alert(1)', 'data:text/html,evil', 'vbscript:evil']) {
    const prepared = prepareBody(`<p><a href="${href}">label</a></p>`, () => undefined);
    assert.ok(prepared);
    assert.doesNotMatch(prepared.html, /href=/i);
  }
  assert.match(prepareBody('<p><a href="https://example.org/">safe</a></p>', () => undefined).html, /https:\/\/example.org/);
});

test('script-only content cannot become a sendable message', () => {
  const prepared = prepareBody('<script>alert(1)</script>', () => undefined);
  assert.ok(!prepared || prepared.blank);
});

test('native mention identifiers resolve only through the supplied authorized directory', () => {
  const id = 'native_person-123_AB';
  const body = `<p>Hi <action-text-attachment content-type="application/vnd.campfire.mention" sgid="${id}"></action-text-attachment></p>`;
  assert.equal(userIdFromSgid(id), id);
  assert.deepEqual(userIdsIn(body), [id]);
  const prepared = prepareBody(body, (sgid) => sgid === id ? { id, name: 'Ada' } : undefined);
  assert.deepEqual(prepared.mentions, [{ id, name: 'Ada' }]);
  assert.deepEqual(prepareBody(body, () => undefined).mentions, []);
  assert.equal(userIdFromSgid('javascript:alert(1)'), undefined);
});
