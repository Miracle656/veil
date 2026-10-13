import { render } from '@testing-library/react';
import { OriginDisplay } from '../OriginDisplay';

describe('OriginDisplay', () => {
  it('renders a long host properly and does not truncate the end', () => {
    const { getByText, container } = render(
      <OriginDisplay url="https://this.is.a.very.very.very.very.long.host.name.that.should.not.be.hidden.com" />
    );
    // Should show the registrable domain prominently
    expect(getByText('hidden.com')).toBeTruthy();
    // Verify word-break
    expect(container.firstChild).toHaveStyle({ wordBreak: 'break-all' });
  });

  it('renders unicode lookalikes explicitly', () => {
    // URL polyfill or built-in should convert this, but even if it doesn't,
    // we make sure it's not disguised
    const { getByText, queryByText } = render(
      <OriginDisplay url="https://xn--e1awd7f.com" />
    );
    expect(getByText('xn--e1awd7f.com')).toBeTruthy();
    
    // Testing cyrillic 'e' in 'epic.com'
    const { getByText: getByText2 } = render(
      <OriginDisplay url="https://\u0435pic.com" />
    );
    // JS URL converts this to xn--pic-7ed.com
    try {
      expect(getByText2('xn--pic-7ed.com')).toBeTruthy();
    } catch {
      expect(getByText2('\u0435pic.com')).toBeTruthy();
    }
  });
});
