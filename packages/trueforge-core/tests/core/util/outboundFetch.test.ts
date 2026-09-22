import { configureOutboundUrlGuard } from '../../../src/core/index';
import { assertOutboundUrl, outboundFetch } from '../../../src/core/util/outboundFetch';

afterEach(() => {
  configureOutboundUrlGuard({ allowedHosts: [], blockedHosts: [] });
});

describe('outbound policy default on Node', () => {
  it('refuses private addresses once the core barrel is loaded', async () => {
    await expect(outboundFetch('http://127.0.0.1:1/')).rejects.toThrow('Outbound URL blocked');
    await expect(assertOutboundUrl('http://169.254.169.254/')).rejects.toThrow('Outbound URL blocked');
  });

  it('lets an explicit configure call override the default', async () => {
    configureOutboundUrlGuard({ allowedHosts: ['127.0.0.1'], blockedHosts: [] });
    await expect(assertOutboundUrl('http://127.0.0.1:1/')).resolves.toBeUndefined();

    configureOutboundUrlGuard({ enabled: false, allowedHosts: [], blockedHosts: [] });
    await expect(assertOutboundUrl('http://10.0.0.1/')).resolves.toBeUndefined();
  });
});
