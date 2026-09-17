import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appHomeHref, integrationsHref, isIntegrationsPath } from '../src/integrationsRoute';

describe('integrationsRoute (default public prefix=/)', () => {
  it('links to the page under the public prefix', () => {
    assert.equal(integrationsHref(), '/integrations');
    assert.equal(appHomeHref(), '/');
  });

  it('matches the page with or without a trailing slash', () => {
    assert.equal(isIntegrationsPath('/integrations'), true);
    assert.equal(isIntegrationsPath('/integrations/'), true);
  });

  it('does not match the app shell or a lookalike path', () => {
    assert.equal(isIntegrationsPath('/'), false);
    assert.equal(isIntegrationsPath('/sessions/abc'), false);
    assert.equal(isIntegrationsPath('/integrations/slack'), false);
    assert.equal(isIntegrationsPath('/my-integrations'), false);
  });

  it('matches under a reverse-proxied public prefix, and not outside it', () => {
    const base = '/custom/proxy/path/';
    assert.equal(isIntegrationsPath('/custom/proxy/path/integrations', base), true);
    assert.equal(isIntegrationsPath('/custom/proxy/path/integrations/', base), true);
    assert.equal(isIntegrationsPath('/integrations', base), false);
  });

  it('accepts a prefix given without its trailing slash', () => {
    assert.equal(isIntegrationsPath('/proxy/integrations', '/proxy'), true);
  });
});
