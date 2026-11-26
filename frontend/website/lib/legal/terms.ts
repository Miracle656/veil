import type { LegalSection } from '@/components/LegalPage'
import { LEGAL_ENTITY_NAME, LEGAL_RC, SUPPORT_EMAIL } from '@/lib/site'

/**
 * The Terms of Service, as data.
 *
 * Every factual sentence here describes how Veil actually works: who holds the
 * keys, where the naira side runs, what cannot be undone. If the product
 * changes, this file changes with it, and `TERMS_UPDATED` moves.
 */
export const TERMS_UPDATED = '25 November 2026'

export const TERMS_INTRO: string[] = [
  `These terms are an agreement between you and ${LEGAL_ENTITY_NAME}, a company registered in Nigeria (RC ${LEGAL_RC}). "Veil", "we" and "us" mean that company. They cover the Veil website, the Veil web wallet, the Veil mobile app, Veil Connect, Veil names and the Veil agent.`,
  'By creating a wallet or using Veil you agree to these terms and to our Privacy Policy. If you do not agree, please do not use Veil.',
  'The short version: Veil is a tool for controlling your own money. We do not hold it, we cannot move it, and we cannot get it back for you if you lose access.',
]

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: 'Who can use Veil',
    body: [
      [
        'You must be at least 18 years old.',
        'You must be allowed to use Veil under the laws of the place where you live.',
        'You must not be on a sanctions list, or act for someone who is.',
      ],
    ],
  },
  {
    heading: 'What Veil is',
    body: [
      'Veil is software that lets you create and control a wallet on the Stellar network. Your wallet is a smart contract on that network. It is controlled by your passkey, which lives on your device or in your password manager and is unlocked with your face, fingerprint or screen lock.',
      'Veil is self-custody. This means:',
      [
        'We never hold your money and never have your keys.',
        'We cannot move, freeze, reverse or refund a transaction.',
        'We cannot reset your passkey or recover your wallet for you.',
        'Your wallet keeps working on the Stellar network even if Veil stops operating.',
      ],
      'Veil is not a bank. Money in your wallet is not a bank deposit and is not covered by deposit insurance.',
    ],
  },
  {
    heading: 'Your passkey, your backup and your spending account',
    body: [
      'You are responsible for keeping access to your wallet.',
      [
        'If you lose your passkey and have not set up a backup in Veil, the money in your wallet cannot be moved by anyone, including us.',
        'Do not delete your Veil passkey from your phone, browser or password manager.',
        'Your wallet has a small spending account that pays network fees. Its key is stored on your device or in your browser. Clearing app data, clearing site data or uninstalling can delete that key and the money in that account. Keep only small amounts there and save the key when Veil offers to.',
        'Anyone who can unlock your device may be able to use your wallet. Keep your device locked.',
      ],
    ],
  },
  {
    heading: 'Transactions',
    body: [
      [
        'Transactions on the Stellar network are final. Check the address and the amount before you confirm.',
        'Money sent to a wrong address cannot be recovered by us.',
        'The Stellar network charges a small fee on every transaction. We do not control that fee.',
        'The network or the services Veil depends on may be slow or unavailable at times.',
      ],
    ],
  },
  {
    heading: 'Veil fees',
    body: [
      'Some actions carry a Veil fee. It is added to the transaction you approve and is paid on top of the amount you send. Veil names are rented for a period and are priced when you register them. We may change our fees. A change applies only to transactions you make after it.',
      'Fees already paid are not refundable, because we cannot reverse a transaction.',
    ],
  },
  {
    heading: 'Buying with naira, cashing out, bills and airtime',
    body: [
      'These services are provided through licensed third-party payment partners, not by us.',
      [
        'To use them you must pass an identity check, which is carried out by the payment partner.',
        'The rate and the amount you will receive are shown when you make an order. Rates change.',
        'We do not hold your naira at any point. Naira moves between your bank and the payment partner.',
        'An order can be delayed, refused or refunded by the payment partner or by a bank. Refunds follow the payment partner\'s rules.',
        'You must use your own bank account and your own identity.',
        'We may limit or stop these services, or refuse an order, where the law or a partner requires it or where we suspect fraud.',
      ],
    ],
  },
  {
    heading: 'Swap, Earn and other third-party services',
    body: [
      'Veil gives you a way to use services run by others on the Stellar network, such as exchanges and lending pools. We do not run or control them.',
      [
        'You can lose some or all of the money you put into them.',
        'Returns shown in Veil are estimates. They are not promised.',
        'Nothing in Veil is financial, investment, legal or tax advice.',
        'You are responsible for any tax you owe.',
      ],
    ],
  },
  {
    heading: 'The Veil agent',
    body: [
      'The agent is an AI assistant. It can make mistakes or misunderstand you. It cannot move your money by itself: every transaction it prepares needs your approval. Read what you are approving. Do not treat anything the agent says as advice.',
    ],
  },
  {
    heading: 'Veil Connect and other apps',
    body: [
      'Other apps can ask your Veil wallet to share its address or to make a payment. You see each request and decide. Those apps are separate businesses with their own terms. We are not a party to what you buy from them or what they owe you, and we cannot refund a payment you made to them.',
    ],
  },
  {
    heading: 'What you must not do',
    body: [
      [
        'Break the law, or help someone else to.',
        'Use Veil for fraud, money laundering, terrorist financing or to avoid sanctions.',
        'Use someone else\'s identity, bank account or wallet without their permission.',
        'Attack, overload or try to break Veil or the services it depends on.',
        'Pretend to be Veil or to act for us.',
      ],
    ],
  },
  {
    heading: 'Changes and availability',
    body: [
      'Veil is new and still changing. We may add, change or remove features. We may suspend or end your access to our apps and services if you break these terms, if the law requires it, or to protect users. We cannot and will not touch the money in your wallet: it stays under your control on the Stellar network.',
    ],
  },
  {
    heading: 'Our code and our name',
    body: [
      'Most of Veil\'s code is open source under the MIT licence, and you may use it under that licence. The Veil name, logo and artwork belong to us and are not covered by it.',
    ],
  },
  {
    heading: 'No guarantees',
    body: [
      'We work hard to make Veil safe and reliable, but we provide it as it is. We do not promise that it will always be available, free of errors or suited to your needs. Digital assets can lose value, and smart contracts, networks and devices can fail.',
    ],
  },
  {
    heading: 'Limits on our responsibility',
    body: [
      'As far as the law allows, we are not responsible for:',
      [
        'losing access to your wallet, passkey, device or spending account;',
        'transactions you approved, including to a wrong address or to a scam;',
        'changes in the value of any asset;',
        'failures of the Stellar network, payment partners, banks or other third parties;',
        'indirect losses such as lost profit.',
      ],
      'Where we are responsible, our total liability to you is limited to the Veil fees you paid us in the 12 months before the claim.',
      'Nothing in these terms removes rights you have under Nigerian consumer protection law that cannot be removed by agreement.',
    ],
  },
  {
    heading: 'Changes to these terms',
    body: [
      'We may update these terms. We will change the date at the top and, for important changes, tell you in the app. If you keep using Veil after a change, you accept the new terms.',
    ],
  },
  {
    heading: 'Law and disputes',
    body: [
      'These terms are governed by the laws of the Federal Republic of Nigeria. If you have a complaint, contact us first and we will try to resolve it. If we cannot, the courts of Nigeria will decide the dispute.',
    ],
  },
  {
    heading: 'Contact',
    body: [`Questions about these terms: ${SUPPORT_EMAIL}`],
  },
]
