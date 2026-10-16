'use client'

/**
 * Verify once — the one-time NIN check that stands in front of every naira flow.
 *
 * A route rather than a step inside Buy, because it belongs to neither flow and
 * blocks both. The port of `frontend/mobile/app/verify.tsx`, and the rules it
 * encodes are the expensive ones:
 *
 *   - **Mainnet only.** A NIN verifies once, ever, against one customer
 *     reference, and the reference is derived from the wallet address, which
 *     differs per network. Verifying from testnet spends someone's single
 *     permanent registration on a reference their mainnet wallet can never
 *     produce, and only Linq can undo that.
 *   - **"Already used" is not a rejection.** Linq allows one verified customer
 *     per NIN forever, so this is the expected reply for someone who verified
 *     before under a different reference. Telling them to check their eleven
 *     digits when the digits are right is the worst answer available, so that
 *     case gets its own screen and their reference to hand to support.
 *   - **Nothing optimistic is written.** `verified` is recorded only with the
 *     answer Linq gave; a browser that believes it is verified when Linq
 *     disagrees cannot recover.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { Card, PageHeader, PrimaryAction, SectionLabel } from '@/components/ui/primitives'
import { ninFailureFor, isNinSpent, type NinFailure } from '@/lib/ninFailure'
import {
  getCustomerRef,
  isNairaKycMismatch,
  isNairaNetwork,
  loadVerifyDetails,
  provisionCustomer,
  saveVerifyDetails,
  setNairaKycMismatch,
  setNairaVerified,
  submitKyc,
} from '@/lib/ngn'

const NIN_LENGTH = 11

type Stage = 'who' | 'nin' | 'rejected' | 'done'

export default function VerifyPage() {
  const router = useRouter()
  const params = useSearchParams()
  const returnTo = params.get('returnTo') || '/buy-ngn'

  const mainnetOnly = !isNairaNetwork()

  const [stage, setStage] = useState<Stage>('who')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [nin, setNin] = useState('')
  const [busy, setBusy] = useState(false)
  const [rejection, setRejection] = useState<string | null>(null)
  const [stranded, setStranded] = useState(false)
  /**
   * Which call failed. Provisioning runs before the NIN is sent, so a failure
   * there is not a NIN rejection and must not be reported as one — the number
   * was never checked, nothing was spent, and "check your 11 digits" is advice
   * about a step that did not happen.
   */
  const [failedPhase, setFailedPhase] = useState<'provision' | 'kyc'>('kyc')
  /** What the provider's code says this failure was, when it sent one. */
  const [failure, setFailure] = useState<NinFailure | null>(null)
  const [customerRef, setCustomerRef] = useState<string | null>(null)

  useEffect(() => {
    setCustomerRef(getCustomerRef())
    if (isNairaKycMismatch()) {
      setStranded(true)
      setStage('rejected')
    }
    const saved = loadVerifyDetails()
    if (saved) {
      setFirstName(saved.firstName)
      setLastName(saved.lastName)
      setEmail(saved.email)
      setPhone(saved.phone)
    }
  }, [])


  const whoReady = useMemo(
    () =>
      firstName.trim().length > 0
      && lastName.trim().length > 0
      && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
      && phone.trim().length >= 10,
    [firstName, lastName, email, phone],
  )

  const verify = useCallback(async () => {
    if (!customerRef || nin.length !== NIN_LENGTH || mainnetOnly) return
    setBusy(true)
    setRejection(null)
    setStranded(false)
    setFailure(null)
    setFailedPhase('provision')
    try {
      // Ask Linq what it already thinks of this reference before spending a NIN
      // attempt on it. Provisioning is idempotent, so this is a read we were
      // making anyway — and it finishes someone whose reference support has
      // just re-bound without submitting anything.
      const customer = await provisionCustomer({
        customerRef,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
      })

      if (customer.verified) {
        setNin('')
        setNairaVerified(true)
        setNairaKycMismatch(false)
        setStage('done')
        return
      }

      // Past this line a failure is about the NIN itself.
      setFailedPhase('kyc')
      const result = await submitKyc(customerRef, nin)
      setNin('')
      if (result.verified) {
        setNairaVerified(true)
        setStage('done')
      } else {
        setRejection(null)
        setStage('rejected')
      }
    } catch (err) {
      setNin('')
      const message = err instanceof Error ? err.message : String(err)
      // The code when there is one, the prose only when there is not. A
      // reworded provider message must not send someone whose NIN is spent to
      // a screen about a spelling that is never checked.
      const code = (err as { code?: string })?.code
      setFailure(ninFailureFor(code))
      const spent = code
        ? isNinSpent(code)
        : /already|duplicate|exists|in use|verified/i.test(message)

      if (spent) {
        // Both halves are now known and together they are conclusive: Linq says
        // this reference is unverified, and says this NIN is spent. So the NIN
        // is bound to some other reference and no retry here reaches it.
        setNairaKycMismatch(true)
        setStranded(true)
        setStage('rejected')
        return
      }
      setRejection(message)
      setStage('rejected')
    } finally {
      setBusy(false)
    }
  }, [customerRef, nin, firstName, lastName, email, phone, mainnetOnly])

  return (
    <>
      <PageHeader eyebrow="Verify once" title="Nigerian identity" />

      <div className="mt-[26px] max-w-[560px] flex flex-col gap-5">
        {mainnetOnly && (
          <Card className="border-[rgba(220,38,38,0.35)]">
            <p className="text-[15px] font-semibold text-off-white mb-2">
              Switch to mainnet to verify
            </p>
            <p className="text-[13px] leading-relaxed text-white/55">
              Your NIN can be verified once, ever, and it gets tied to the wallet you verify
              from. Doing that on testnet would spend it on a wallet that only exists there,
              and your real one could never be verified afterwards. Switch network in
              Settings, then come back.
            </p>
          </Card>
        )}

        {stage === 'who' && (
          <Card>
            <SectionLabel>Your details</SectionLabel>
            <p className="text-[13px] leading-relaxed text-white/55 mt-3 mb-5">
              These go to our naira partner so they can match your NIN. Use the name exactly
              as it appears on your NIN record.
            </p>
            <div className="flex flex-col gap-3">
              <Field label="First name" value={firstName} onChange={setFirstName} />
              <Field label="Last name" value={lastName} onChange={setLastName} />
              <Field label="Email" value={email} onChange={setEmail} type="email" />
              <Field label="Phone" value={phone} onChange={setPhone} type="tel" />
            </div>
            <div className="mt-6">
              <PrimaryAction
                disabled={!whoReady || mainnetOnly}
                onClick={() => {
                  saveVerifyDetails({ firstName, lastName, email, phone })
                  setStage('nin')
                }}
              >
                Continue
              </PrimaryAction>
            </div>
          </Card>
        )}

        {stage === 'nin' && (
          <Card>
            <SectionLabel>National Identification Number</SectionLabel>
            <p className="text-[13px] leading-relaxed text-white/55 mt-3 mb-5">
              Eleven digits. It is sent once to verify you and is never stored by Veil.
            </p>
            <input
              inputMode="numeric"
              autoComplete="off"
              value={nin}
              onChange={(e) => setNin(e.target.value.replace(/\D/g, '').slice(0, NIN_LENGTH))}
              placeholder="00000000000"
              className="w-full bg-surface-md border border-border-strong rounded-[14px] px-4 py-3 text-off-white tracking-[0.3em] font-mono outline-none focus:border-gold"
            />
            <div className="mt-6">
              <PrimaryAction
                disabled={busy || nin.length !== NIN_LENGTH || mainnetOnly}
                onClick={() => void verify()}
              >
                {busy ? 'Checking…' : 'Verify'}
              </PrimaryAction>
            </div>
            <button
              type="button"
              onClick={() => setStage('who')}
              className="w-full text-center text-[13px] text-white/45 mt-4 hover:text-white/70"
            >
              Edit my name
            </button>
          </Card>
        )}

        {stage === 'rejected' && stranded && (
          // Not a rejection at all: the digits are right and the name matches.
          // Linq has this NIN against another reference, so there is nothing to
          // correct and nothing to retry.
          <Card className="border-[rgba(220,38,38,0.35)]">
            <p className="text-[15px] font-semibold text-off-white mb-2">
              This NIN is already verified elsewhere
            </p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-3">
              Your NIN is fine. It is verified against a different customer reference — most
              likely one from an earlier wallet — and a NIN can only ever verify one.
              Retrying here cannot reach it.
            </p>
            <p className="text-[12px] font-mono text-gold break-all mb-3">
              Reference: {customerRef ?? '—'}
            </p>
            <p className="text-[13px] leading-relaxed text-white/55">
              Send that reference to support. Once they have re-bound it, come back and this
              screen will finish without asking for your NIN again.
            </p>
          </Card>
        )}

        {stage === 'rejected' && !stranded && failedPhase === 'provision' && (
          <Card className="border-[rgba(220,38,38,0.35)]">
            <p className="text-[15px] font-semibold text-off-white mb-2">
              Couldn&apos;t set up your details
            </p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-3">
              This failed before your NIN was sent, so it was never checked and nothing has
              been used up. The naira service would not accept the details on the previous
              screen — most often the email or the phone number.
            </p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-3">
              Check the email is one you can receive at, and try the phone in full
              international form, for example +2348030000000.
            </p>
            {rejection && <p className="text-[12px] text-white/40 mb-5">{rejection}</p>}
            <PrimaryAction onClick={() => setStage('who')}>Edit my details</PrimaryAction>
          </Card>
        )}

        {stage === 'rejected' && !stranded && failedPhase === 'kyc' && (
          <Card className="border-[rgba(220,38,38,0.35)]">
            {/* The provider's own code when it sent one, and only then a generic
                line. Guessing is how this screen came to tell people their name
                was wrong when the name is never checked at all. */}
            <p className="text-[15px] font-semibold text-off-white mb-2">
              {failure?.title ?? "That NIN didn't verify"}
            </p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-3">
              {failure?.body
                ?? 'Check the 11 digits against your NIN slip. Only the number is checked, so your name, its order and any middle names make no difference here.'}
            </p>
            {rejection && <p className="text-[12px] text-white/40 mb-3">{rejection}</p>}
            <p className="text-[12px] text-white/40 mb-5">
              Nothing was saved and your NIN has not been used up.
            </p>
            <PrimaryAction onClick={() => setStage('nin')}>Try again</PrimaryAction>
            <button
              type="button"
              onClick={() => {
                setNin('')
                setStage('who')
              }}
              className="w-full text-center text-[13px] text-white/45 mt-4 hover:text-white/70"
            >
              Edit my name
            </button>
          </Card>
        )}

        {stage === 'done' && (
          <Card>
            <p className="text-[15px] font-semibold text-off-white mb-2">You&apos;re verified</p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-5">
              This is a one-time check. You will not be asked again on this wallet.
            </p>
            <PrimaryAction onClick={() => router.replace(returnTo)}>Continue</PrimaryAction>
          </Card>
        )}
      </div>
    </>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <label className="flex flex-col gap-[6px]">
      <span className="text-[12px] text-white/45">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-surface-md border border-border-dim rounded-[14px] px-4 py-3 text-off-white outline-none focus:border-gold"
      />
    </label>
  )
}
