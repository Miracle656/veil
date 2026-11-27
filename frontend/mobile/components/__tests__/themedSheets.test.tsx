import React from 'react';
import { setTheme, THEMES } from '../../lib/theme';
import { ContactPicker } from '../ContactPicker';
import { ConnectDAppModal } from '../ConnectDAppModal';
import { WalletConnectApprovalModal } from '../WalletConnectApprovalModal';

// Mock dependencies
jest.mock('expo-camera', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    CameraView: (props: any) => React.createElement(View, { testID: 'mock-camera-view', ...props }),
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
  };
});

jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(async () => 'wc:test-uri'),
  setStringAsync: jest.fn(async () => true),
}));

jest.mock('../../lib/passkey', () => ({
  registerPasskeySigner: jest.fn(() => () => {}),
}));

const mockPendingRequest = {
  id: 1,
  topic: 'test-topic',
  method: 'stellar_signXDR',
  params: {},
  chainId: 'stellar:pubnet',
  raw: {},
};

const mockSession = {
  topic: 'test-topic',
  peer: {
    name: 'Uniswap Stellar',
    icons: ['https://example.com/logo.png'],
  },
};

let mockPendingRequests: any[] = [mockPendingRequest];

jest.mock('../../hooks/useWalletConnect', () => ({
  useWalletConnect: () => ({
    isReady: true,
    error: null,
    pendingProposal: null,
    pendingRequests: mockPendingRequests,
    sessions: [mockSession],
    pair: jest.fn(),
    approveSession: jest.fn(),
    rejectSession: jest.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const renderer = require('react-test-renderer');

describe('Themed Sheets (#1390)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
  });

  const themes: ('light' | 'dark')[] = ['light', 'dark'];

  describe.each(themes)('under %s theme', (theme) => {
    beforeEach(async () => {
      await setTheme(theme);
    });

    it('renders ContactPicker with themed colors', () => {
      let tree: any;
      renderer.act(() => {
        tree = renderer.create(
          <ContactPicker visible={true} onSelect={jest.fn()} onClose={jest.fn()} />
        );
      });
      expect(tree.toJSON()).toBeTruthy();
      const themedSurfaces = tree.root.findAll(
        (node: any) => node.props?.style?.backgroundColor === THEMES[theme].surfaceRaised
      );
      expect(themedSurfaces.length).toBeGreaterThan(0);
      renderer.act(() => {
        tree.unmount();
      });
    });

    it('renders ConnectDAppModal with themed colors', () => {
      let tree: any;
      renderer.act(() => {
        tree = renderer.create(
          <ConnectDAppModal isOpen={true} onClose={jest.fn()} onConnected={jest.fn()} />
        );
      });
      expect(tree.toJSON()).toBeTruthy();
      const themedSurfaces = tree.root.findAll(
        (node: any) => node.props?.style?.backgroundColor === THEMES[theme].surfaceRaised
      );
      expect(themedSurfaces.length).toBeGreaterThan(0);
      renderer.act(() => {
        tree.unmount();
      });
    });

    it('renders WalletConnectApprovalModal with themed colors when pending requests exist', () => {
      mockPendingRequests = [mockPendingRequest];
      let tree: any;
      renderer.act(() => {
        tree = renderer.create(<WalletConnectApprovalModal />);
      });
      expect(tree.toJSON()).toBeTruthy();
      const themedSurfaces = tree.root.findAll(
        (node: any) => node.props?.style?.backgroundColor === THEMES[theme].surfaceRaised
      );
      expect(themedSurfaces.length).toBeGreaterThan(0);
      renderer.act(() => {
        tree.unmount();
      });
    });

    it('renders WalletConnectApprovalModal safely when no requests are pending', () => {
      mockPendingRequests = [];
      let tree: any;
      renderer.act(() => {
        tree = renderer.create(<WalletConnectApprovalModal />);
      });
      expect(tree.toJSON()).toBeNull();
      renderer.act(() => {
        tree.unmount();
      });
    });
  });
});
