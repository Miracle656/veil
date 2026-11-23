import { EMPTY_WALLET_MESSAGE, isHorizonNotFound, loadPayingAccount } from '../horizonError'

describe('a paying account that does not exist', () => {
  const notFound = Object.assign(new Error('Not Found'), { name: 'NotFoundError', response: { status: 404 } })

  it('recognises Horizon saying 404, in either shape', () => {
    expect(isHorizonNotFound(notFound)).toBe(true)
    expect(isHorizonNotFound({ response: { status: 404 } })).toBe(true)
    expect(isHorizonNotFound({ response: { status: 400 } })).toBe(false)
    expect(isHorizonNotFound(new Error('Not Found'))).toBe(false)
    expect(isHorizonNotFound(null)).toBe(false)
  })

  it('says the wallet is empty instead of "Not Found"', async () => {
    await expect(loadPayingAccount(() => Promise.reject(notFound))).rejects.toThrow(EMPTY_WALLET_MESSAGE)
  })

  it('passes an account, and any other failure, straight through', async () => {
    await expect(loadPayingAccount(() => Promise.resolve('account'))).resolves.toBe('account')
    const other = new Error('network down')
    await expect(loadPayingAccount(() => Promise.reject(other))).rejects.toBe(other)
  })
})
