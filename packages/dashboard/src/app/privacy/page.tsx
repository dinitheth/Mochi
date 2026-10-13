import Link from 'next/link';

export const metadata = { title: 'Privacy Policy · Mochi', description: 'How Mochi handles account, Google sign-in, wallet, and service data.' };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      <Link className="text-sm text-violet-300" href="/about">← Mochi</Link>
      <h1 className="mt-6 text-3xl font-bold">Mochi Privacy Policy</h1>
      <p className="mt-2 text-sm text-white/55">Last updated: October 13, 2026</p>
      <div className="mt-8 space-y-7 text-sm leading-7 text-white/75">
        <section><h2 className="text-lg font-semibold text-white">Information Mochi handles</h2><p className="mt-2">Mochi handles account identifiers and sign-in information needed to authenticate you, including your email address and identity-provider subject. If you choose Google sign-in, Google provides Mochi the basic OpenID Connect identity information requested by the sign-in flow (openid, email, and profile). Mochi does not request access to Gmail, Drive, or other Google content.</p><p className="mt-2">When you use Mochi, the service may also handle your MCP connection and authorization records, wallet addresses and wallet-provider identifiers, preferences and approval policies, contacts you save, transaction/payment preparation and activity records, and requests needed to provide Monad network and supported integration data. Public blockchain data and transactions are visible on their respective networks.</p></section>
        <section><h2 className="text-lg font-semibold text-white">How information is used</h2><p className="mt-2">Mochi uses this information to sign you in, associate your Mochi data with your account, provide the tools you request, enforce authorization and approval rules, protect the service, troubleshoot failures, and maintain security and audit records. Mochi does not use Google sign-in to obtain unrelated Google account content.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Service providers and sharing</h2><p className="mt-2">Mochi uses Amazon Web Services for hosting and authentication infrastructure, Privy for supported wallet services, and network/data providers required by tools you choose to use. Information is shared with these providers only as needed to operate the requested feature, secure the service, or comply with law. Blockchain transactions that you approve are broadcast to the relevant public network.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Storage and security</h2><p className="mt-2">Mochi stores account-linked application records and OAuth connection state in its hosted infrastructure. Mochi uses access controls and transport encryption, but no online service can guarantee absolute security. Wallet signing is handled through the configured wallet provider or signer; never share passwords, recovery phrases, or private keys in a chat.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Retention and your choices</h2><p className="mt-2">Records are retained while needed to provide and secure Mochi, meet legal obligations, or resolve disputes. You can disconnect the Mochi connector in ChatGPT settings and may request account/data deletion or ask questions by emailing <a className="text-violet-300" href="mailto:dinithmain@gmail.com">dinithmain@gmail.com</a>. Some public blockchain records cannot be deleted, and backups or security records may persist for a limited period.</p></section>
        <section><h2 className="text-lg font-semibold text-white">Changes and contact</h2><p className="mt-2">Mochi may update this policy as its features change. The revised date will be shown above. Questions or privacy requests: <a className="text-violet-300" href="mailto:dinithmain@gmail.com">dinithmain@gmail.com</a>.</p></section>
      </div>
      <footer className="mt-12 flex gap-5 border-t border-white/10 pt-5 text-sm text-violet-300"><Link href="/about">Home</Link><Link href="/terms">Terms</Link></footer>
    </main>
  );
}
