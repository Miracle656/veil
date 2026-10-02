import type { Meta, StoryObj } from '@storybook/react';
import { ConnectButton } from './ConnectButton';

const meta: Meta<typeof ConnectButton> = {
  title: 'Components/ConnectButton',
  component: ConnectButton,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ConnectButton>;

export const Disconnected: Story = { args: { connected: false } };
export const Connecting: Story = { args: { connected: false, loading: true } };
export const Connected: Story = {
  args: { connected: true, address: 'GCEXAMPLE7WALLET4ADDRESS' },
};
