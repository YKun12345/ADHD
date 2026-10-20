// Decode original metadata for consistency only. Server MAC verification grants authority.
function decodeOriginalContext(token, prefix) {
  try {
    const parts = token.split('.')
    if (parts.length !== 4 || parts[0] !== prefix || parts[1] !== 'v1' || !/^[a-f0-9]{64}$/.test(parts[3]) ||
      !/^[A-Za-z0-9_-]+$/.test(parts[2]) || parts[2].length % 4 === 1 || token.length > 65536) return null
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let buffer = 0, bits = 0, encoded = ''
    for (const character of parts[2]) {
      buffer = buffer * 64 + alphabet.indexOf(character); bits += 6
      if (bits >= 8) {
        bits -= 8; encoded += '%' + ('0' + ((buffer >> bits) & 255).toString(16)).slice(-2)
        buffer &= (1 << bits) - 1
      }
    }
    return JSON.parse(decodeURIComponent(encoded))
  } catch (_) { return null }
}
module.exports = { decodeOriginalContext }
