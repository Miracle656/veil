const { renderSwift, SHORTCUTS } = require('../withIosAppShortcuts');

describe('withIosAppShortcuts', () => {
  it('renders read-only intents for every configured action', () => {
    const swift = renderSwift();

    expect(SHORTCUTS).toHaveLength(2);
    expect(swift).toContain('struct VeilAppShortcuts: AppShortcutsProvider');
    expect(swift).toContain('struct ShowBalanceIntent: AppIntent');
    expect(swift).toContain('What is my balance? in \\\\(.applicationName)');
    expect(swift).toContain('How much I get? in \\\\(.applicationName)');
    expect(swift).toContain('Wetin be my balance? in \\\\(.applicationName)');
    expect(swift).toContain('struct ShowXlmPriceIntent: AppIntent');
  });

  it('only opens existing read-only deep links', () => {
    const swift = renderSwift();

    expect(swift).toContain('veil://dashboard');
    expect(swift).toContain('veil://token/XLM');
    expect(swift).not.toMatch(/sign|send|privateKey|secret|seed/i);
  });
});
