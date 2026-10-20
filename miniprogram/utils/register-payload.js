function buildRegistrationPayload(form = {}) {
  const forChild = form.patientType === 'child'
  const payload = {
    email: String(form.email || '').trim().toLowerCase(),
    password: String(form.password || ''),
    full_name: String((forChild ? form.guardianName : form.fullName) || '').trim(),
    role: 'patient',
    consent_agreed: form.consentAgreed === true,
    patient_profile: {
      age: Number(form.age),
      gender: form.gender || null,
      patient_type: form.patientType
    }
  }
  if (forChild) {
    payload.patient_profile.display_name = String(form.fullName || '').trim()
    payload.guardian = {
      age: Number(form.guardianAge),
      relation: form.guardianRelation,
      confirmed: form.guardianConfirmed === true
    }
    const note = String(form.proofReference || '').trim()
    if (note) payload.guardian.proof_reference = note
  }
  return payload
}

module.exports = {
  buildRegistrationPayload
}
