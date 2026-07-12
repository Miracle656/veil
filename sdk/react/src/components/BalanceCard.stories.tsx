import type { Meta, StoryObj } from '@storybook/react';
import { BalanceCard } from './BalanceCard';

const meta: Meta<typeof BalanceCard> = {
  title: 'Components/BalanceCard',
  component: BalanceCard,
  parameters: { layout: 'centered' },
  args: { amount: 1_234_567_8900n, assetCode: 'XLM' },
};
export default meta;

type Story = StoryObj<typeof BalanceCard>;

export const Default: Story = {};
export const Zero: Story = { args: { amount: 0n } };
export const CustomAsset: Story = { args: { amount: 5_000_000n, assetCode: 'USDC' } };
export const Loading: Story = { args: { amount: undefined, loading: true } };
export const ErrorState: Story = { args: { error: 'Could not load balance' } };
