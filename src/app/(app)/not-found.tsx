import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-2xl px-5 py-10 md:px-12">
      <div className="pf-label">Not found</div>
      <h1 className="mt-2 text-headline font-semibold tracking-[-0.02em]">There&rsquo;s nothing here.</h1>
      <p className="mt-3 text-body text-ink-2">The link may be old, or the record belongs to another workspace.</p>
      <Link href="/" className="mt-6 inline-block text-body-sm text-muted hover:text-ink">
        Go home
      </Link>
    </div>
  );
}
