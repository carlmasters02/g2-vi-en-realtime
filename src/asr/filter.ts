// Whisper hallucinates stock phrases when fed silence, low-level noise, or
// music. These come from its training data (subtitle corpora, YouTube).
// Cheap, effective defence: drop chunks whose output matches known filler.

const HALLUCINATIONS = [
  /^thanks? (you )?for watching/i,
  /^thank you\.?$/i,
  /^please subscribe/i,
  /^subscribe to/i,
  /^like and subscribe/i,
  /^the speaker is speaking/i,
  /^\[?(music|applause|silence|laughter|inaudible|blank_audio)\]?\.?$/i,
  /^bye\.?$/i,
  /^you\.?$/i,
  /^\.+$/,
  /^okay\.?$/i,
  /^hmm+\.?$/i,
]

export function isHallucination(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (HALLUCINATIONS.some(re => re.test(t))) return true
  // A chunk that is one short word is almost never a real 4s utterance.
  if (t.length < 4) return true
  return false
}
