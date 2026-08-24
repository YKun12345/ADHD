const {
  capturePatientDataLease,
  isPatientDataLeaseCurrent
} = require('./session-privacy')

function beginAuthAttempt(page) {
  const id = (page._authAttemptId || 0) + 1
  page._authAttemptId = id
  page._authPageActive = true

  return {
    id,
    lease: capturePatientDataLease()
  }
}

function isAuthAttemptCurrent(page, attempt) {
  return isAuthAttemptActive(page, attempt) &&
    isPatientDataLeaseCurrent(attempt.lease)
}

function isAuthAttemptActive(page, attempt) {
  return Boolean(page) &&
    Boolean(attempt) &&
    page._authPageActive === true &&
    page._authAttemptId === attempt.id
}

function invalidateAuthAttempt(page, resetSubmitting = true) {
  page._authPageActive = false
  page._authAttemptId = (page._authAttemptId || 0) + 1

  if (
    resetSubmitting &&
    page.data &&
    page.data.submitting === true &&
    typeof page.setData === 'function'
  ) {
    page.setData({ submitting: false })
  }
}

module.exports = {
  beginAuthAttempt,
  isAuthAttemptActive,
  isAuthAttemptCurrent,
  invalidateAuthAttempt
}
