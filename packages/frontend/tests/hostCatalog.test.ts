import {
  createTrueForgeCatalog,
  createTrueForgeClient,
} from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const client = createTrueForgeClient({ baseUrl: 'https://trueforge.test' });

describe('host settings catalog', () => {
  it('omits the computer slot, so Settings has no Computers section, unless the server reports it', () => {
    const catalog = createTrueForgeCatalog({ client, computers: false });

    assert.equal(catalog.computerCatalog, undefined);
    assert.notEqual(catalog.sandboxCatalog, undefined);
  });

  it('supplies the computer slot when capabilities.computers.enabled is true', () => {
    const catalog = createTrueForgeCatalog({ client, computers: true });

    assert.equal(typeof catalog.computerCatalog?.listComputers, 'function');
    assert.equal(typeof catalog.computerCatalog?.putComputerAgentAccess, 'function');
  });

  it('defaults to off, so a host that never asked never shows the section', () => {
    assert.equal(createTrueForgeCatalog({ client }).computerCatalog, undefined);
  });
});
