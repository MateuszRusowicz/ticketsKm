/**
 * Concert artwork, with a fallback that carries the layout when there is none.
 *
 * Every seeded concert currently has `imageUrl: null`, and there is no upload
 * path yet — Plan 04 decides between pasted URLs and real uploads. So the
 * fallback is not an edge case here, it is the normal rendering, and the
 * cards have to look deliberate without a picture.
 *
 * A plain <img> rather than next/image: `imageUrl` will hold arbitrary
 * admin-supplied URLs, and next/image requires every host to be declared in
 * `remotePatterns` — which cannot be done before anyone has decided where the
 * files live. Revisit in Plan 04; if uploads land on one known host, switch,
 * and gain resizing and format negotiation.
 */
export function ConcertImage({
  src,
  alt,
  className = '',
}: {
  src: string | null
  alt: string
  className?: string
}) {
  if (!src) {
    return (
      <div
        // Decorative only: the concert title sits next to it, so announcing
        // an empty placeholder would just add noise for a screen reader.
        aria-hidden="true"
        className={`aspect-[3/2] w-full bg-surface ${className}`}
      />
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={`aspect-[3/2] w-full object-cover ${className}`}
    />
  )
}
