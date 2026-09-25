import { render } from '@testing-library/react-native';
import { OriginDisplay } from '../OriginDisplay';

describe('OriginDisplay', () => {
  it('renders a long host properly and does not truncate the end', () => {
    const { getByText, root } = render(
      <OriginDisplay url="https://this.is.a.very.very.very.very.long.host.name.that.should.not.be.hidden.com" />
    );
    expect(getByText('hidden.com')).toBeTruthy();
  });

  it('renders unicode lookalikes explicitly', () => {
    const { getByText } = render(
      <OriginDisplay url="https://xn--e1awd7f.com" />
    );
    expect(getByText('xn--e1awd7f.com')).toBeTruthy();
    
    // Testing cyrillic 'e' in 'epic.com'
    const { getByText: getByText2 } = render(
      <OriginDisplay url="https://\u0435pic.com" />
    );
    try {
      expect(getByText2('xn--pic-7ed.com')).toBeTruthy();
    } catch {
      expect(getByText2('\u0435pic.com')).toBeTruthy();
      expect(getByText2('Unicode characters detected in host')).toBeTruthy();
    }
  });
});
