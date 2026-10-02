import type { Meta, StoryObj } from '@storybook/react';
import { TxStatusPill } from './TxStatusPill';

const meta: Meta<typeof TxStatusPill> = {
  title: 'Components/TxStatusPill',
  component: TxStatusPill,
  parameters: { layout: 'centered' },
  args: { status: 'SUCCESS', hash: 'a1b2c3d4e5f6' },
};
export default meta;

type Story = StoryObj<typeof TxStatusPill>;

export const Success: Story = {};
export const Pending: Story = { args: { status: 'PENDING' } };
export const Failed: Story = { args: { status: 'FAILED', errorMessage: 'tx_failed: insufficient fee' } };
export const NotFound: Story = { args: { status: 'NOT_FOUND', hash: undefined } };
export const Polling: Story = { args: { loading: true } };
