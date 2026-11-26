import {
  chromeOrigin,
  decideNavigation,
  decidePopup,
  parseWindowOpenMessage,
  WINDOW_OPEN_BLOCKER_JS,
  WINDOW_OPEN_MESSAGE_TYPE,
} from '../dappNavigation';

const APPROVED = 'https://app.soroswap.finance';

describe('decideNavigation — staying on the approved origin', () => {
  it('allows the same origin, including sub-paths', () => {
    expect(decideNavigation(APPROVED, `${APPROVED}/swap?asset=XLM`)).toEqual({
      action: 'allow',
    });
  });

  it('allows the blank startup document', () => {
    expect(decideNavigation(APPROVED, 'about:blank')).toEqual({ action: 'allow' });
  });

  it('drops the grant on a redirect to a different origin', () => {
    // This is the acceptance criterion: a redirect elsewhere must not be
    // followed and must not carry the approved origin's grant with it.
    const decision = decideNavigation(APPROVED, 'https://evil.example/steal');
    expect(decision).toEqual({ action: 'external', origin: 'https://evil.example' });
    expect(decision.action).not.toBe('allow');
  });

  it('treats a redirect to another allow-listed origin as leaving too', () => {
    // Being on the allow-list does not make it the origin the user approved.
    expect(decideNavigation(APPROVED, 'https://stellarterm.com/trade')).toEqual({
      action: 'external',
      origin: 'https://stellarterm.com',
    });
  });

  it('blocks plaintext http, even for the approved host', () => {
    expect(decideNavigation(APPROVED, 'http://app.soroswap.finance')).toEqual({
      action: 'blocked',
      reason: 'insecure',
    });
  });

  it('blocks malformed and non-http targets', () => {
    expect(decideNavigation(APPROVED, 'javascript:alert(1)')).toEqual({
      action: 'blocked',
      reason: 'malformed',
    });
    expect(decideNavigation(APPROVED, '')).toEqual({ action: 'blocked', reason: 'malformed' });
  });
});

describe('decidePopup — window.open', () => {
  it('folds a same-origin popup back into the current view', () => {
    // No new window is created, so there is no second opener to inherit grants.
    expect(decidePopup(APPROVED, `${APPROVED}/pools`)).toEqual({ action: 'navigate' });
  });

  it('hands a cross-origin popup to the system browser', () => {
    expect(decidePopup(APPROVED, 'https://evil.example/popup')).toEqual({
      action: 'external',
      origin: 'https://evil.example',
    });
  });

  it('blocks a popup that is not an https origin', () => {
    for (const bad of ['http://evil.example', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', '']) {
      expect(decidePopup(APPROVED, bad)).toEqual({ action: 'block' });
    }
  });

  it('never returns an in-app window for a popup', () => {
    // Every popup decision is either folded into this view or refused; none
    // can produce a popup that keeps the opener's permissions.
    for (const url of ['https://evil.example/x', 'http://evil.example', APPROVED + '/a']) {
      const decision = decidePopup(APPROVED, url);
      expect(['navigate', 'external', 'block']).toContain(decision.action);
    }
  });
});

describe('WINDOW_OPEN_BLOCKER_JS', () => {
  it('overrides window.open so no page can open a window', () => {
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('window.open');
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('return null');
  });

  it('detaches window.opener so a popup cannot inherit permissions', () => {
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('opener');
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('value: null');
  });

  it('reports blocked opens through the documented message type', () => {
    expect(WINDOW_OPEN_BLOCKER_JS).toContain(WINDOW_OPEN_MESSAGE_TYPE);
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('ReactNativeWebView.postMessage');
  });

  it('intercepts target="_blank" links', () => {
    expect(WINDOW_OPEN_BLOCKER_JS).toContain('_blank');
  });
});

describe('parseWindowOpenMessage', () => {
  it('parses a well-formed window-open report', () => {
    const data = JSON.stringify({ type: WINDOW_OPEN_MESSAGE_TYPE, url: 'https://evil.example' });
    expect(parseWindowOpenMessage(data)).toEqual({
      type: WINDOW_OPEN_MESSAGE_TYPE,
      url: 'https://evil.example',
    });
  });

  it('ignores anything that is not a well-formed report', () => {
    expect(parseWindowOpenMessage('not json')).toBeNull();
    expect(parseWindowOpenMessage(JSON.stringify({ type: 'other', url: 'x' }))).toBeNull();
    expect(parseWindowOpenMessage(JSON.stringify({ type: WINDOW_OPEN_MESSAGE_TYPE }))).toBeNull();
  });
});

describe('chromeOrigin — the address bar describes what is loaded', () => {
  it('shows the origin of the loaded page', () => {
    expect(chromeOrigin(APPROVED, `${APPROVED}/swap`)).toBe(APPROVED);
  });

  it('keeps showing the approved origin when the loaded URL is not it', () => {
    // A blocked redirect leaves the page where it was, so the bar must not
    // describe the destination that was refused.
    expect(chromeOrigin(APPROVED, 'https://evil.example')).toBe(APPROVED);
    expect(chromeOrigin(APPROVED, 'http://app.soroswap.finance')).toBe(APPROVED);
  });

  it('falls back to the approved origin before anything has loaded', () => {
    expect(chromeOrigin(APPROVED, null)).toBe(APPROVED);
  });
});
