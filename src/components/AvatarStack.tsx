import type { TripPerson } from '../lib/types'

const MAX_SHOWN = 4

/** Overlapping avatars for multi-person trips — slightly unaligned in a row. */
export default function AvatarStack({
  people,
  size = 28,
}: {
  people: TripPerson[]
  size?: number
}) {
  if (people.length < 2) return null

  const shown = people.slice(0, MAX_SHOWN)
  const extra = people.length - shown.length
  const labels = people.map(p => p.username).join(', ')

  return (
    <div
      className="avatar-stack"
      title={labels}
      aria-label={`Travelers: ${labels}`}
      style={{ ['--avatar-size' as string]: `${size}px` }}
    >
      {shown.map((p, i) => (
        <span
          key={p.id}
          className={`avatar-stack-item avatar-stack-offset-${i % 3}`}
          style={{ zIndex: shown.length - i }}
        >
          {p.avatar_url
            ? <img src={p.avatar_url} alt="" />
            : <span className="avatar-stack-fallback">{(p.username || '?')[0]?.toUpperCase()}</span>}
        </span>
      ))}
      {extra > 0 && (
        <span className="avatar-stack-item avatar-stack-more avatar-stack-offset-0" style={{ zIndex: 0 }}>
          +{extra}
        </span>
      )}
    </div>
  )
}
