// Temporary: fails on purpose, to check that Vercel's Deployment Checks hold production back.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('fails on purpose', () => {
    assert.fail('deployment check test');
});
