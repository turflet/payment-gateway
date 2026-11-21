import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A syntax error in an inline <script> (e.g. `await` outside an async function) stops the whole
// checkout from running, leaving customers on the loading splash. Compile every inline script,
// without executing it, so such a mistake fails CI instead of production.
const pages = ['checkout.html', 'stand.html'];

for (const page of pages) {
  test(`inline scripts in ${page} compile`, () => {
    const html = readFileSync(new URL(`../views/${page}`, import.meta.url), 'utf8');
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, `${page} has inline scripts`);
    scripts.forEach((code, i) => {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${page}#script${i}` }), `${page} script #${i}`);
    });
  });
}
