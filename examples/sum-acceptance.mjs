// Operator-owned acceptance fixture. Always test the candidate cwd, not this script's directory.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { sum } = await import(pathToFileURL(resolve(process.cwd(), 'sum.mjs')).href);
assert.equal(sum([]), 0);
assert.equal(sum([1, 2, 3]), 6);
assert.equal(sum([-5, 2]), -3);
console.log('sum acceptance passed');
