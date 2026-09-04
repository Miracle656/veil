import type { Meta, StoryObj } from '@storybook/react';
import { AccountBadge } from './AccountBadge';

// Short, obviously-fake placeholder (kept well under a real 56-char Stellar key).
const DEMO_ADDRESS = 'GCEXAMPLE7WALLET4ADDRESS';

const meta: Meta<typeof AccountBadge> = {
  title: 'Components/AccountBadge',
  component: AccountBadge,
  parameters: { layout: 'centered' },
  args: { address: DEMO_ADDRESS, isDeployed: true },
};
export default meta;

type Story = StoryObj<typeof AccountBadge>;

export const Deployed: Story = {};
export const NotDeployed: Story = { args: { isDeployed: false } };
export const Loading: Story = { args: { address: undefined, loading: true } };
export const ErrorState: Story = { args: { error: 'Failed to load account' } };
