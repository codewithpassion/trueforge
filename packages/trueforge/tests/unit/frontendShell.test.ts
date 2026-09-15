import { applyShellTokens, renderStaticAssetHeaders } from '../../src/frontendShell';

describe('applyShellTokens', () => {
  it('replaces every base path token in the shell', () => {
    const html =
      '<script src="%%TRUEFORGE_BASE_PATH%%assets/app.js"></script>' +
      "<script>window.__TRUEFORGE_BASE_PATH__='%%TRUEFORGE_BASE_PATH%%';</script>";

    expect(applyShellTokens({ html, uiBasePath: '/' })).toBe(
      '<script src="/assets/app.js"></script>' + "<script>window.__TRUEFORGE_BASE_PATH__='/';</script>",
    );
  });
});

describe('renderStaticAssetHeaders', () => {
  it('caches hashed assets forever and revalidates everything else', () => {
    expect(renderStaticAssetHeaders()).toBe(
      [
        '/*',
        '  Cache-Control: no-cache',
        '',
        '/assets/*',
        '  ! Cache-Control',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ].join('\n'),
    );
  });
});
