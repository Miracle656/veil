'use client'

import { useActivityFeed } from '@/lib/activityFeed'
import { inclusionFee } from '@/lib/fees'
import { maxSendable as libMaxSendable } from '@/lib/sendable'
import { Nav, PageHeader } from '@/components/ui/primitives'
import { Shield } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { resolveFederation } from '@/lib/federation'

import {
  Keypair, TransactionBuilder, BASE_FEE, Asset, Operation, Memo,
  Contract, rpc as SorobanRpc, nativeToScVal, Horizon,
} from '@stellar/stellar-sdk'
import { fetchPlatformFee } from '@/lib/platformFee'
import { walletLocal, walletSession } from '@/lib/walletStorage'
const Server = Horizon.Server
import { ContactPicker } from '@/components/ContactPicker'
import { QrScanner } from '@/components/QrScanner'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { readPaymentRequest, resolveRequestedAsset, type IssuedAsset } from '@/lib/requestedAsset'
// #704: SEP-7 URIs may declare the memo kind; it is parsed alongside the
// memo so the submit path builds the right Stellar Memo instead of assuming
// text.
import { buildStellarMemo, validateMemo } from '@/lib/sep7'
import { getRegisteredAsset } from '@/lib/assets'
import { buildSep7Memo, type Sep7MemoType } from '@/lib/sep7'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'
import { isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { horizonErrorMessage, loadPayingAccount } from '@/lib/horizonError'
import { spendableNativeXlm } from '@/lib/reserves'
import { validateMemoText } from '@/lib/memo'

import { getNativeAssetContractId, getNetwork, getNetworkName } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { fetchPrices } from '@/lib/fetchPrice'
import { formatFiat, hydrateCurrency, useCurrency } from '@/lib/currency'
import { isPrivacyEnabled } from '@/lib/privacy/config'
import { getConnectApp, referenceMemo, type PendingConnect } from '@/lib/connect'
import { ALLOW_DEMO_APP, answer, clearPending, readPending } from '@/lib/connectWindow'
import { readContractAssetBalances } from '@/lib/contractAssets'
import { movableWalletAssets, walletBalanceToOffer, type IssuedWalletAsset } from '@/lib/moveFromWallet'
import { moveAssetToSpending } from '@/lib/moveToSpending'
// TODO(#1003): remove platform limitation warning when multi-origin contract ships
import {
  FIRST_SPEND_LIMITATION_MESSAGE,
  isFirstSpend,
  markFirstSpendCompleted,
} from '@/lib/platformLimitation'
