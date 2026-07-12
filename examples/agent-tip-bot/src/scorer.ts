import type { Post } from './posts.js'

export interface ScoreResult {
  postId: string
  score: number
  breakdown: {
    engagementScore: number
    contentLengthScore: number
    originalityScore: number
  }
  reason: string
}

/**
 * Score a post 0–100.
 *
 * Engagement (50 pts): weighted sum of likes, reposts, replies.
 * Content length (30 pts): rewards substantive posts over one-liners.
 * Originality (20 pts): presence of technical keywords and links.
 */
export function scorePost(post: Post): ScoreResult {
  // Engagement — normalised against a high-performer ceiling
  const engagementRaw = post.likes * 1 + post.reposts * 3 + post.replies * 2
  const engagementScore = Math.min(50, Math.round((engagementRaw / 800) * 50))

  // Content length — up to 30 pts for posts over 100 chars
  const len = post.content.length
  const contentLengthScore = len < 20
    ? 0
    : len < 100
      ? Math.round((len / 100) * 15)
      : Math.min(30, Math.round(15 + ((len - 100) / 200) * 15))

  // Originality — 20 pts max for technical / substantive signals
  const technicalKeywords = [
    'open-source', 'open source', 'github', 'thread', 'writeup', 'benchmarks',
    'proof', 'zero-knowledge', 'smart contract', 'soroban', 'stellar', 'sdk',
    'research', 'tutorial', 'explained', 'deep dive', 'simulation', 'mit',
  ]
  const hits = technicalKeywords.filter(kw => post.content.toLowerCase().includes(kw)).length
  const originalityScore = Math.min(20, hits * 5)

  const score = engagementScore + contentLengthScore + originalityScore

  const reason = [
    `engagement ${engagementScore}/50`,
    `length ${contentLengthScore}/30`,
    `originality ${originalityScore}/20`,
  ].join(', ')

  return {
    postId: post.id,
    score,
    breakdown: { engagementScore, contentLengthScore, originalityScore },
    reason,
  }
}
