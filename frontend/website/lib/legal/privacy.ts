import type { LegalSection } from '@/components/LegalPage'
import { LEGAL_ENTITY_NAME, LEGAL_RC, SUPPORT_EMAIL } from '@/lib/site'

/**
 * The Privacy Policy, as data.
 *
 * Every claim about what is and is not collected is a claim about the code.
 * Before changing what Veil stores or who it sends data to, change this file
 * in the same pull request and move `PRIVACY_UPDATED`.
 */
export const PRIVACY_UPDATED = '25 November 2026'

export const PRIVACY_INTRO: string[] = [
  `This policy explains what personal data Veil handles, why, and what your rights are. Veil is a product of ${LEGAL_ENTITY_NAME}, a company registered in Nigeria (RC ${LEGAL_RC}), which is the data controller. We handle personal data under the Nigeria Data Protection Act 2023.`,
  'The short version: you can create a Veil wallet without giving us your name, email or phone number. We never see your passkey, your face or your fingerprint. We only handle personal data when a feature needs it, such as buying with naira.',
]

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: 'What we never collect',
    body: [
      [
        'Your passkey or any private key that controls your wallet.',
        'Your face or fingerprint. These stay on your device and are checked by your device, not by us.',
        'A seed phrase. Veil wallets do not have one.',
      ],
    ],
  },
  {
    heading: 'What we handle, and when',
    body: [
      'When you use the wallet:',
      [
        'Your wallet addresses and your activity on the Stellar network. This is public on the blockchain. We read and index it so the app can show your balance and history.',
        'Technical data such as your IP address, device type and app version, which our servers and hosting providers receive when the app connects to them.',
        'Error reports when something goes wrong in the app, so we can fix it.',
      ],
      'When you buy with naira, cash out, pay a bill or buy airtime:',
      [
        'Your identity details for the identity check, including your NIN. These go to our licensed payment partner, who carries out the check. We do not store your NIN.',
        'Your bank account details for a cash-out. These go to the payment partner to make the payout. We keep only what is needed to show you which payout an order was.',
        'The phone number or meter number you are paying for.',
        'A record of each order: its amount, rate, status, time and your wallet address.',
      ],
      'When you use the Veil agent:',
      [
        'Your messages, and the wallet information needed to answer them such as balances, are sent to an AI model provider to produce a reply.',
      ],
      'When you contact us or join our community:',
      [
        'What you send us, and the contact details you use.',
        'If you link your wallet to our Discord, your Discord account and the wallet addresses you linked.',
      ],
    ],
  },
  {
    heading: 'What stays on your device',
    body: [
      'Your wallet settings, your contacts list and the key for your spending account are stored on your device or in your browser. We do not receive them. If you clear app data or site data they are deleted, and we cannot restore them.',
    ],
  },
  {
    heading: 'Why we handle it',
    body: [
      [
        'To provide the service you asked for (performing our agreement with you).',
        'To meet legal duties, such as rules against money laundering and fraud.',
        'To keep Veil secure and working, and to fix problems (our legitimate interest).',
        'With your consent, where the law requires it. You can withdraw consent at any time.',
      ],
      'We do not sell your personal data. We do not use it for advertising.',
    ],
  },
  {
    heading: 'Who we share it with',
    body: [
      [
        'Our payment partners, for naira services and the identity check they must carry out.',
        'Companies that host our apps, servers and database.',
        'The AI model provider that powers the agent.',
        'Our error-reporting provider.',
        'Regulators, courts or law enforcement, when the law requires us to.',
        'Another app, when you choose to share your wallet address or make a payment through Veil Connect. Each request is shown to you first.',
      ],
      'Some of these companies are outside Nigeria. When data leaves Nigeria we rely on the safeguards the Nigeria Data Protection Act allows.',
    ],
  },
  {
    heading: 'The blockchain is public and permanent',
    body: [
      'Transactions on the Stellar network can be seen by anyone and cannot be deleted or changed by us or by anyone else. If your wallet address becomes linked to you, your past transactions can be linked to you too. A payment may carry a short reference (a memo), which is also public.',
    ],
  },
  {
    heading: 'How long we keep it',
    body: [
      'We keep order records and related data for as long as we need them to provide the service and to meet legal and accounting duties, and then delete them or make them anonymous. Error reports and server logs are kept for a short time. Our payment partners keep identity records for the period the law requires of them.',
    ],
  },
  {
    heading: 'Your rights',
    body: [
      'Under the Nigeria Data Protection Act you can ask us to:',
      [
        'tell you what personal data we hold about you and give you a copy;',
        'correct data that is wrong;',
        'delete your data, where we are not required to keep it;',
        'stop or limit how we use it;',
        'give you your data in a form you can take elsewhere.',
      ],
      `To use these rights, email ${SUPPORT_EMAIL}. We may need to confirm that the request comes from you. We cannot delete or change data on the blockchain.`,
      'You can also complain to the Nigeria Data Protection Commission.',
    ],
  },
  {
    heading: 'Security',
    body: [
      'We limit who can access personal data, use encrypted connections, and collect as little as we can. No system is perfectly secure. If a breach puts your rights at risk, we will tell you and the regulator as the law requires.',
    ],
  },
  {
    heading: 'Cookies and tracking',
    body: [
      'We do not use advertising trackers. The wallet stores data in your browser because it needs it to work, as described above.',
    ],
  },
  {
    heading: 'Children',
    body: ['Veil is for people aged 18 and over. We do not knowingly handle the data of children.'],
  },
  {
    heading: 'Changes to this policy',
    body: [
      'We may update this policy. We will change the date at the top and, for important changes, tell you in the app.',
    ],
  },
  {
    heading: 'Contact',
    body: [`Questions or requests about your data: ${SUPPORT_EMAIL}`],
  },
]
