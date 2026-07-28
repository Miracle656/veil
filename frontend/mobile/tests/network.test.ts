import assert from 'node:assert'
import {
  NETWORKS,
  getNetwork,
  walletConfig,
  getNativeAssetContractId,
  buildFriendbotUrl,
} from '../lib/network'

function testNetworkDefaults() {
  const net = getNetwork()
  assert.strictEqual(net.name, 'testnet')
  assert.strictEqual(net.displayName, 'Stellar Testnet')
  assert.strictEqual(net.horizonUrl, 'https://horizon-testnet.stellar.org')
  assert.strictEqual(net.rpcUrl, 'https://soroban-testnet.stellar.org')
  assert.strictEqual(net.friendbotUrl, 'https://friendbot.stellar.org')
}

function testWalletConfig() {
  assert.notStrictEqual(walletConfig.factoryAddress, undefined)
  assert.strictEqual(walletConfig.rpcUrl, 'https://soroban-testnet.stellar.org')
  assert.strictEqual(walletConfig.networkPassphrase, NETWORKS.testnet.networkPassphrase)
}

function testGetNativeAssetContractId() {
  const contractId = getNativeAssetContractId()
  assert.strictEqual(typeof contractId, 'string')
  assert.ok(contractId.length > 0)
}

function testBuildFriendbotUrl() {
  const testAddr = 'GD5DJ67Z7M4Y'
  const url = buildFriendbotUrl(testAddr)
  assert.strictEqual(url, `https://friendbot.stellar.org/?addr=${encodeURIComponent(testAddr)}`)
  assert.strictEqual(NETWORKS.mainnet.friendbotUrl, null)
}

function runAllTests() {
  testNetworkDefaults()
  testWalletConfig()
  testGetNativeAssetContractId()
  testBuildFriendbotUrl()
  console.log('All mobile network tests passed successfully!')
}

runAllTests()
