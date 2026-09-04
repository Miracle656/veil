/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx,js,jsx}',
    './components/**/*.{ts,tsx,js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        /* Stellar Brand Manual 2025 — Primary */
        gold:        '#FDDA24',
        'near-black': '#0F0F0F',
        'off-white':  '#F6F7F8',

        /* Stellar Brand Manual 2025 — Secondary */
        lilac:       '#B7ACE8',
        teal:        '#00A7B5',
        'warm-grey': '#D6D2C4',
        navy:        '#002E5D',
      },
      fontFamily: {
        /* Stellar brand type stack */
        lora:  ['var(--font-lora)', 'Lora', 'Georgia', 'serif'],
        inter: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        anton: ['var(--font-anton)', 'Anton', 'Impact', 'sans-serif'],
        sans:  ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        mono:  ['var(--font-inconsolata)', 'Inconsolata', 'Courier New', 'monospace'],
      },
      fontSize: {
        'display-xl': ['5rem',   { lineHeight: '1.04', letterSpacing: '-0.025em' }],
        'display-lg': ['4rem',   { lineHeight: '1.06', letterSpacing: '-0.02em'  }],
        'display':    ['3rem',   { lineHeight: '1.08', letterSpacing: '-0.018em' }],
        'display-sm': ['2.25rem',{ lineHeight: '1.1',  letterSpacing: '-0.015em' }],
      },
      borderRadius: {
        'pill': '100px',
      },
      transitionTimingFunction: {
        'stellar': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}
