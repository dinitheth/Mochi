import Link from 'next/link';

export const metadata = { title: 'Terms of Service · Mochi', description: 'Terms for using Mochi wallet and Monad tools.' };

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      <Link className="text-sm text-violet-300" href="/about">← Mochi</Link>
      <h1 className="mt-6 text-3xl font-bold">Mochi Terms of Service</h1>
      <p className="mt-2 text-sm text-white/55">Last updated: October 13, 2026</p>
      <div className="mt-8 space-y-7 text-sm leading-7 text-white/75">
        <section><h2 className="text-lg font-semibold text-white">About these terms</h2><p className="mt-2">These terms govern your use of Mochi, including its MCP server, dashboard, and related wallet and Monad tools. By connecting to or using Mochi, you agree to these terms. If you do not agree, do not use the service. Mochi is currently an experimental service operated by its developer; contact <a className="text-violet-300" href="mailto:dinithmain@gmail.com">dinithmain@gmail.com</a> with questions.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Wallets and transactions</h2><p className="mt-2">You are responsible for your account, wallet, credentials, and decisions. Mochi can provide information or prepare supported actions, and some actions may be submitted only after applicable approval. Review addresses, amounts, fees, network, and transaction details yourself before approving. Blockchain transactions are generally irreversible; Mochi cannot reverse them or guarantee execution, price, availability, or outcome.</p></section>
        <section><h2 className="text-lg font-semibold text-white">No financial or custody advice</h2><p className="mt-2">Mochi is software, not a bank, broker, investment adviser, or tax adviser. Information and quotes may be incomplete, delayed, or inaccurate and are not financial, investment, legal, or tax advice. Wallet and network features depend on third-party providers and public blockchains.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Experimental features and risk</h2><p className="mt-2">Some integrations, tokens, and smart contracts are experimental or unaudited and may contain defects or lose value. Use the service at your own risk and do not use assets you cannot afford to lose. You must comply with applicable laws and must not misuse, attack, or attempt to disrupt Mochi or its providers.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Availability and third parties</h2><p className="mt-2">Mochi may change, suspend, or discontinue features for maintenance, security, legal, or operational reasons. Third-party services and blockchain networks have their own terms and privacy practices; Mochi does not control them.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Liability and changes</h2><p className="mt-2">To the maximum extent permitted by applicable law, Mochi is provided “as is” without warranties, and its operator is not liable for indirect or consequential losses, lost profits, lost data, or digital-asset losses arising from use of the service. Nothing in these terms excludes liability that cannot legally be excluded. Mochi may update these terms; continued use after an update means you accept the revised terms.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Contact</h2><p className="mt-2">Questions about these terms: <a className="text-violet-300" href="mailto:dinithmain@gmail.com">dinithmain@gmail.com</a>.</p></section>
      </div>
      <footer className="mt-12 flex gap-5 border-t border-white/10 pt-5 text-sm text-violet-300"><Link href="/about">Home</Link><Link href="/privacy">Privacy</Link></footer>
    </main>
  );
}
