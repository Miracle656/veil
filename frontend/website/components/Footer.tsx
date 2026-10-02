const LINKS = {
  Project: [
    { label: 'Documentation', href: 'https://docs.useveilapp.xyz' },
    { label: 'GitHub',        href: 'https://github.com/Miracle656/veil' },
    { label: 'Roadmap',       href: '#roadmap' },
    { label: 'Changelog',     href: '#' },
  ],
  Resources: [
    { label: 'Stellar Developers', href: 'https://developers.stellar.org' },
    { label: 'Soroban',            href: 'https://soroban.stellar.org' },
    { label: 'WebAuthn Guide',     href: 'https://webauthn.guide' },
    { label: 'FIDO2 Spec',         href: 'https://fidoalliance.org' },
  ],
  Community: [
    { label: 'Stellar Discord', href: 'https://discord.gg/stellardev' },
    { label: 'Open Issues',     href: 'https://github.com/Miracle656/veil/issues' },
    { label: 'Contributing',    href: 'https://docs.useveilapp.xyz/getting-started' },
    { label: 'Twitter / X',     href: '#' },
  ],
}

export default function Footer() {
  return (
    <footer className="border-t border-white/[0.06] pt-16 pb-10 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 mb-14">

          {/* Brand */}
          <div>
            <div className="flex items-center gap-2.5 mb-5">
              <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
                <rect width="28" height="28" rx="6" fill="#05A2C2" />
                <path d="M8 14.5h12M14 8.5v11" stroke="#000" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="font-semibold text-[16px] tracking-tight text-white">Veil</span>
            </div>
            <p className="text-[#555] text-sm leading-relaxed max-w-xs">
              Passkey-powered smart wallets on Stellar Soroban. No seed phrases.
              No private key exposure. Just your fingerprint.
            </p>
            <div className="flex items-center gap-2 mt-5">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#30A46C' }} />
              <span className="text-xs text-[#555]">Testnet launching soon</span>
            </div>
          </div>

          {/* Link columns */}
          {Object.entries(LINKS).map(([group, links]) => (
            <div key={group}>
              <h4 className="text-[11px] uppercase tracking-[0.2em] text-[#8f8f8f] font-medium mb-4">
                {group}
              </h4>
              <ul className="space-y-3">
                {links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={link.href.startsWith('http') ? '_blank' : undefined}
                      rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                      className="text-sm text-[#555] hover:text-[#8f8f8f] transition-colors duration-150"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/[0.05] pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-[#333]">
            © {new Date().getFullYear()} Invisible Wallet (Veil). MIT License.
          </p>
          <div className="flex items-center gap-4 text-xs text-[#333]">
            <span>Stellar Soroban</span>
            <span>·</span>
            <span>WebAuthn / FIDO2</span>
            <span>·</span>
            <span>P-256 ECDSA</span>
          </div>
        </div>
      </div>
    </footer>
  )
}
