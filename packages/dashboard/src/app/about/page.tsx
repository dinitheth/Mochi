import Link from 'next/link';
import McpEndpoint from '@/components/McpEndpoint';

export const metadata = {
  title: 'Mochi — Your Monad wallet, in your flow',
  description: 'Meet Mochi: wallet, payment, NFT, and Monad tools for your AI assistant, with clear controls for actions involving your funds.',
};

const capabilities = [
  {
    number: '01',
    eyebrow: 'FOR YOUR WALLET',
    title: 'See what’s happening with your money',
    points: [
      'Check MON and supported token balances, your wallet address, and the total value of your wallet.',
      'Review recent token transfers in plain language and look up transaction status.',
      'Save people by name, send MON or supported tokens, and see an estimated network fee.',
    ],
    icon: '◉',
  },
  {
    number: '02',
    eyebrow: 'FOR BUSINESSES',
    title: 'Manage customer and supplier payments',
    points: [
      'Create AUSD payment requests with a shareable QR code and wallet link.',
      'Check incoming payments, review invoices, and keep a searchable payment history.',
      'Prepare supplier payouts in batches of up to 20, issue eligible refunds, and export closeout reports.',
    ],
    icon: '↗',
  },
  {
    number: '03',
    eyebrow: 'FOR RESEARCH',
    title: 'Explore Monad and your positions',
    points: [
      'Look up token prices, recent market trends, and token movement on Monad.',
      'Find Monad NFT collections, view active OpenSea listings, and check NFTs held by a wallet.',
      'Check Aave lending and Kintsu staking balances, and explore Perpl and Kuru markets.',
    ],
    icon: '✳',
  },
  {
    number: '04',
    eyebrow: 'WHEN YOU WANT TO ACT',
    title: 'Prepare actions with clear review',
    points: [
      'Get an estimate for supported token swaps before deciding whether to continue.',
      'Prepare supported payments, token sends, staking, NFT purchases, and other wallet actions.',
      'Review actions that need approval before they go through, then follow their status and receipt.',
    ],
    icon: '✦',
  },
];

const steps = [
  ['Connect', 'Add Mochi to an MCP-compatible assistant and sign in to your Mochi account.'],
  ['Ask naturally', 'Ask about your wallet, a payment, or Monad activity in your own words.'],
  ['Review before action', 'When an action needs approval, review what it will do before it can continue.'],
];

export default function AboutPage() {
  return (
    <main className="mochi-landing">
      <header className="landing-nav">
        <Link href="/about" className="landing-brand" aria-label="Mochi home">
          <span className="brand-mark">m</span>
          <span>mochi</span>
          <span className="brand-network">MONAD</span>
        </Link>
        <nav aria-label="Main navigation" className="landing-links">
          <a href="#what-it-does">What Mochi does</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <a className="landing-nav-cta" href="#connect">Connect Mochi <span aria-hidden="true">↗</span></a>
      </header>

      <section className="landing-hero">
        <div className="hero-copy">
          <div className="landing-kicker"><span className="status-dot" /> YOUR MONAD WALLET, IN YOUR FLOW</div>
          <h1>Money tools that<br /><span>feel more human.</span></h1>
          <p className="hero-lede">
            Check MON and token balances, review NFT listings, get supported swap estimates, and manage AUSD payment requests or payouts—all by asking in plain language.
          </p>
          <div className="hero-actions">
            <a className="button-primary" href="#connect">Connect Mochi <span aria-hidden="true">↗</span></a>
            <a className="button-secondary" href="#what-it-does">See what Mochi does</a>
          </div>
          <div className="hero-note"><span aria-hidden="true">✦</span> Clear answers. Thoughtful controls. Built for everyday use.</div>
        </div>

        <div className="hero-visual" aria-label="Example of a Mochi conversation">
          <div className="visual-glow" />
          <div className="conversation-card">
            <div className="conversation-topline"><span className="mini-brand"><span className="brand-mark small">m</span> Mochi</span><span className="example-label">EXAMPLE</span></div>
            <div className="chat-bubble user-bubble">Can you help me review this payment?</div>
            <div className="chat-bubble mochi-bubble">
              <span className="bubble-eyebrow">PAYMENT REQUEST</span>
              <strong>Ready for your review</strong>
              <span>Check the recipient and amount before deciding.</span>
              <span className="review-chip"><span className="status-dot" /> Your approval may be needed</span>
            </div>
            <div className="conversation-footer"><span className="tiny-dot" /><span className="tiny-dot" /><span className="tiny-dot" /><span className="footer-caption">An example Mochi interaction</span></div>
          </div>
          <div className="float-pill float-one"><span>✳</span> Wallet insights</div>
          <div className="float-pill float-two"><span>↗</span> Payments</div>
        </div>
      </section>

      <section className="connect-strip" id="connect">
        <div className="connect-copy">
          <p className="section-kicker">READY WHEN YOU ARE</p>
          <h2>Bring Mochi into your assistant.</h2>
          <p>Use this address when adding Mochi as a custom MCP connection.</p>
        </div>
        <McpEndpoint />
      </section>

      <section className="features-section" id="what-it-does">
        <div className="section-heading">
          <p className="section-kicker">HERE’S WHAT YOU CAN ASK</p>
          <h2>What Mochi actually does</h2>
          <p>From a quick wallet check to a full payment closeout, Mochi helps with practical tasks across Monad.</p>
        </div>
        <div className="feature-grid">
          {capabilities.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <div className="feature-top"><span className="feature-icon" aria-hidden="true">{feature.icon}</span><span className="feature-number">{feature.eyebrow}</span></div>
              <h3>{feature.title}</h3>
              <ul>
                {feature.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </article>
          ))}
        </div>
        <div className="feature-ribbon">
          <div><span className="ribbon-spark">✦</span><strong>For people</strong><span>“Check my balance.” “Show my NFTs.” “What happened to that transfer?”</span></div>
          <div><span className="ribbon-spark">✦</span><strong>For business</strong><span>“Create an AUSD request.” “Check these invoices.” “Prepare supplier payouts.”</span></div>
        </div>
        <p className="capability-note">Some features depend on the connected service and available Monad data. NFT marketplace and lending actions that use Mochi demo contracts are experimental; check each action carefully before approving it.</p>
      </section>

      <section className="safety-section" id="how-it-works">
        <div className="safety-intro">
          <p className="section-kicker">YOUR WALLET. YOUR CALL.</p>
          <h2>Helpful by design.<br /><span>Always in your hands.</span></h2>
          <p>Mochi can answer questions and prepare supported actions. When an action needs approval, you can review what it will do before it is submitted.</p>
        </div>
        <div className="steps-list">
          {steps.map(([title, text], index) => (
            <div className="step-row" key={title}>
              <span className="step-index">0{index + 1}</span>
              <div><h3>{title}</h3><p>{text}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="final-cta">
        <div className="final-spark" aria-hidden="true">✳</div>
        <p className="section-kicker">A CALMER WAY TO USE MONAD</p>
        <h2>Make your next wallet task<br />a little easier.</h2>
        <a className="button-primary" href="#connect">Connect Mochi <span aria-hidden="true">↗</span></a>
      </section>

      <footer className="landing-footer">
        <Link href="/about" className="landing-brand footer-brand"><span className="brand-mark">m</span><span>mochi</span></Link>
        <p>Mochi is an experimental service. Availability varies by feature and provider. Review every action involving your funds.</p>
        <div className="footer-links"><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:dinithmain@gmail.com">Contact</a></div>
      </footer>
    </main>
  );
}
