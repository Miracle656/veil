import { supabase } from './supabase'

export interface PaymentSchedule {
  id?: string | number
  owner: string
  dest: string
  asset: string
  amount: string
  cadence: string
  next_run: string
  status: string // 'active' | 'paused' | 'completed' etc.
}

export async function createSchedule(schedule: Omit<PaymentSchedule, 'id'>): Promise<PaymentSchedule> {
  const { data, error } = await supabase
    .from('payment_schedules')
    .insert([schedule])
    .select()
    .single()

  if (error) {
    throw error
  }
  return data
}

export async function getSchedules(owner: string): Promise<PaymentSchedule[]> {
  const { data, error } = await supabase
    .from('payment_schedules')
    .select('*')
    .eq('owner', owner)
    .order('next_run', { ascending: true })

  if (error) {
    throw error
  }
  return data || []
}

export async function deleteSchedule(id: string | number): Promise<void> {
  const { error } = await supabase
    .from('payment_schedules')
    .delete()
    .eq('id', id)

  if (error) {
    throw error
  }
}

export async function updateSchedule(id: string | number, updates: Partial<PaymentSchedule>): Promise<PaymentSchedule> {
  const { data, error } = await supabase
    .from('payment_schedules')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    throw error
  }
  return data
}

export async function getDueSchedules(owner: string): Promise<PaymentSchedule[]> {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('payment_schedules')
    .select('*')
    .eq('owner', owner)
    .eq('status', 'active')
    .lte('next_run', now)

  if (error) {
    throw error
  }
  return data || []
}

export function advanceNextRun(cadence: string, currentNextRun: string): string {
  const date = new Date(currentNextRun)
  if (isNaN(date.getTime())) {
    return new Date().toISOString()
  }

  switch (cadence.toLowerCase()) {
    case 'daily':
      date.setDate(date.getDate() + 1)
      break
    case 'weekly':
      date.setDate(date.getDate() + 7)
      break
    case 'monthly':
      date.setMonth(date.getMonth() + 1)
      break
    default:
      // Default to 1 day
      date.setDate(date.getDate() + 1)
  }

  return date.toISOString()
}
