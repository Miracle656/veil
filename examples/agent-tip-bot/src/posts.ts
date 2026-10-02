/**
 * Simulated post scraper.
 *
 * In production, replace fetchPosts() with a real social-media API call
 * (e.g. X/Twitter API, Farcaster Hub, Lens, etc.).  The shape of the
 * returned Post objects is all the agent cares about.
 */

export interface Post {
  id: string
  creator: string
  /** Stellar testnet address of the creator (G...) */
  creatorAddress: string
  content: string
  likes: number
  reposts: number
  replies: number
  createdAt: string
}

const MOCK_POSTS: Post[] = [
  {
    id: 'post-001',
    creator: 'alice_dev',
    creatorAddress: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
    content: 'Just shipped a zero-knowledge proof verifier in 200 lines of Rust. Full writeup with benchmarks on my blog. This took 3 months of nights and weekends — happy to answer questions!',
    likes: 312,
    reposts: 87,
    replies: 44,
    createdAt: '2026-06-28T08:00:00Z',
  },
  {
    id: 'post-002',
    creator: 'bob_crypto',
    creatorAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
    content: 'gm',
    likes: 5,
    reposts: 0,
    replies: 1,
    createdAt: '2026-06-28T09:00:00Z',
  },
  {
    id: 'post-003',
    creator: 'carol_builder',
    creatorAddress: 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7',
    content: 'Open-sourced my Stellar smart wallet recovery kit — supports passkey migration, guardian setup, and multi-device sync. All under MIT. Tested across 6 mobile browsers.',
    likes: 198,
    reposts: 63,
    replies: 29,
    createdAt: '2026-06-28T10:00:00Z',
  },
  {
    id: 'post-004',
    creator: 'dave_meme',
    creatorAddress: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    content: 'crypto go up 📈📈📈',
    likes: 22,
    reposts: 3,
    replies: 2,
    createdAt: '2026-06-28T11:00:00Z',
  },
  {
    id: 'post-005',
    creator: 'eve_research',
    creatorAddress: 'GDFOHLMYCADVTC4CJFMVXWNX6SFTKHPABNKZAUGWZYVUZ6XGQO2CAHKN',
    content: 'Deep dive: how Stellar consensus actually prevents double-spends at the protocol level. Includes a simulation you can run locally. 4000 word thread 🧵',
    likes: 445,
    reposts: 132,
    replies: 71,
    createdAt: '2026-06-28T12:00:00Z',
  },
]

export async function fetchPosts(_creator?: string): Promise<Post[]> {
  // Simulates a network fetch delay
  await new Promise(r => setTimeout(r, 100))
  if (_creator) {
    return MOCK_POSTS.filter(p => p.creator === _creator)
  }
  return MOCK_POSTS
}
