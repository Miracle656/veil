import type { Meta, StoryObj } from '@storybook/react';
import { SendPaymentForm } from './SendPaymentForm';

const meta: Meta<typeof SendPaymentForm> = {
  title: 'Components/SendPaymentForm',
  component: SendPaymentForm,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof SendPaymentForm>;

export const Default: Story = {};
export const Sending: Story = { args: { loading: true } };
export const WithError: Story = { args: { error: 'Insufficient balance' } };
export const Success: Story = { args: { success: 'Sent — tx a1b2c3d4…' } };
