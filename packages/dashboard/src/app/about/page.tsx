import Link from 'next/link';

export const metadata = {
  title: 'Mochi — Monad wallet tools for AI assistants',
  description: 'Connect an MCP-compatible AI assistant to your Mochi wallet and Monad tools, with explicit approval for transactions.',
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-14 sm:py-20">
      <p className="text-sm font-semibold tracking-wide text-violet-300">MOCHI · MONAD</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">Your Monad tools, in the conversation.</h1>
      <p className="mt-6 text-lg leading-8 text-white/70">
        Mochi connects MCP-compatible AI assistants to wallet, portfolio, market, and Monad network tools. Sign in with your own Mochi account so your wallet data stays associated with your identity.
      </p>
      <section className="mt-10 grid gap-4 sm:grid-cols-2">
        <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="font-semibold">Explore and prepare</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">Ask for balances, portfolio context, network information, and supported transaction or payment preparations.</p>
        </article>
        <article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h2 className="font-semibold">Keep control</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">Mochi applies its approval rules to supported actions. Review transaction details carefully before approving anything on-chain.</p>
        </article>
      </section>
      <p className="mt-8 text-sm leading-6 text-white/55">Mochi is an experimental software service. Some ecosystem integrations and smart contracts may be unaudited. Do not use them with assets you cannot afford to lose.</p>
      <footer className="mt-12 flex gap-5 border-t border-white/10 pt-5 text-sm text-violet-300">
        <Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><a href="mailto:dinithmain@gmail.com">Contact</a>
      </footer>
    </main>
  );
}
