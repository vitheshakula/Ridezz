import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEmailAllowed } from './access';

describe('isEmailAllowed', () => {
  it('lets everyone in when there is no allowlist', () => {
    assert.equal(isEmailAllowed(null, 'anyone@gmail.com'), true);
  });

  it('lets in only listed addresses when there is one', () => {
    const allowed = new Set(['a@gmail.com']);
    assert.equal(isEmailAllowed(allowed, 'a@gmail.com'), true);
    assert.equal(isEmailAllowed(allowed, 'b@gmail.com'), false);
    assert.equal(isEmailAllowed(allowed, 'a@gmail.com.evil.io'), false);
  });

  it('treats an allowlist that exists but is empty as closed to everyone, not open', () => {
    assert.equal(isEmailAllowed(new Set(), 'a@gmail.com'), false);
  });
});
