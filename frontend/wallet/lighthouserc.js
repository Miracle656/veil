module.exports = {
    ci: {
        collect: {
            url: ['http://localhost:3000'],
            staticDistDir: './.next/standalone',
            maxWaitForLoad: 10000,
            numberOfRuns: 1,
        },
        upload: {
            target: 'temporary-public-storage',
        },
        assert: {
            preset: 'lighthouse:recommended',
            assertions: {
                'categories:performance': ['error', { minScore: 0.80 }],
                'categories:accessibility': ['error', { minScore: 0.90 }],
                'categories:pwa': ['error', { minScore: 0.80 }],
                'categories:best-practices': ['error', { minScore: 0.90 }],
            },
        },
    },
};
