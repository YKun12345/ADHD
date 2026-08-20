function buildRegistrationPayload(form = {}) {
  return {
    email: String(form.email || '').trim().toLowerCase(),
    password: String(form.password || ''),
    full_name: String(form.fullName || '').trim(),
    role: 'patient',
    consent_agreed: form.consentAgreed === true,
    patient_profile: {
      age: Number(form.age),
      gender: form.gender || null,
      patient_type: form.patientType
    }
  }
}

module.exports = {
  buildRegistrationPayload
}
