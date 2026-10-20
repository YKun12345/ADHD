// Syntactic server-context fixtures only. Actual HTTP tests obtain signed tokens from the service.
function syntheticSendContext(changes = {}) {
  const value = { purpose: 'shared_message_send', version: 1, sender_user_id: 7, patient_id: 8, relationship_id: 20,
    relationship_revision: 2, doctor_user_id: 90, patient_actor_user_id: 7, sender_identity_basis: 'self:7:access:1:revision:1',
    authorization_snapshot: [], ...changes }
  return 'shared-message-context.v1.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.' + 'a'.repeat(64)
}
const readSyntheticContext = token => JSON.parse(Buffer.from(token.split('.')[2], 'base64url').toString('utf8'))
module.exports = { syntheticSendContext, readSyntheticContext }
