const { request } = require('../../utils/request')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')

const SCOPE = ['profile', 'assessment', 'tracking', 'care', 'imaging']
const PURPOSE = { basic_use: '基本使用', clinical_sharing: '临床共享', external_ai: '外部AI', research: '具体研究' }
const STATUS = { pending: '等待双方确认', active: '有效', confirmed: '监护人已确认', verified: '已核验', unverified: '未核验', revoked: '已撤回', expired: '已到期', suspended: '已暂停', rejected: '未通过', granted: '已同意', withdrawn: '已撤回', denied: '授权校验未通过', superseded: '已被后续同意替代', transferred: '已完成监护交接', adult_converted: '已转换为成人本人身份' }
const scopeText = items => (items || []).map(key => ({ profile: '基础资料', assessment: '评估与报告', tracking: '记录', care: '任务和消息', imaging: '已有影像分析' }[key] || key)).join('、')
const scopeOptions = values => SCOPE.map(value => ({ value, label: scopeText([value]), checked: values.includes(value) }))
const relationshipState = row => row.effective_status || (row.status === 'active' && row.effective_access === false ? 'denied' : row.status)

Component({
  properties: { role: { type: String, value: 'patient' } },
  data: {
    loading: false, busy: false, errorText: '', statusText: '', userId: null, canInvite: false, canGrantBasic: false,
    patients: [], guardians: [], relationships: [], consents: [], doctorStatus: '',
    patientId: null, targetEmail: '', invitationScope: SCOPE.slice(), scopeOptions: scopeOptions(SCOPE), demonstrationOnly: false,
    identityConfirmationVisible: false, identityRelationshipId: '', identityRevision: '', identityAge: '', identityProof: '', identityPurpose: 'transfer'
  },
  lifetimes: {
    attached() { this.reloadAuthorization() },
    detached() { this._authorizationVersion = (this._authorizationVersion || 0) + 1 }
  },
  pageLifetimes: {
    show() { this.reloadAuthorization() },
    hide() { this._authorizationVersion = (this._authorizationVersion || 0) + 1 }
  },
  methods: {
    _isCurrent(lease, version) {
      return isPatientSessionLeaseCurrent(lease) && version === this._authorizationVersion
    },
    async reloadAuthorization() {
      const lease = capturePatientSessionLease()
      if (!isPatientSessionLeaseCurrent(lease)) return false
      const version = this._authorizationVersion = (this._authorizationVersion || 0) + 1
      this.setData({ loading: true, errorText: '', patients: [], relationships: [], consents: [], guardians: [] })
      try {
        const [context, response] = await Promise.all([
          request({ url: '/identity/context' }), request({ url: '/care/relationships' })
        ])
        if (!this._isCurrent(lease, version)) return false
        const patients = context.accessible_patients || []
        const patientId = patients[0] && patients[0].patient_id
        const consentResponse = patientId
          ? await request({ url: `/patient/consents?patient_id=${encodeURIComponent(patientId)}` })
          : { items: [] }
        if (!this._isCurrent(lease, version)) return false
        this.setData({
          userId: context.user_id, patientId: patientId || null, patients,
          canInvite: Boolean(patientId || context.doctor_qualification?.status === 'verified'),
          canGrantBasic: !consentResponse.items.some(row => row.purpose === 'basic_use' && ['active', 'granted'].includes(row.status) && row.effective_access !== false),
          guardians: (context.guardian_relationships || []).map(row => ({ ...row,
            ageInput: String(row.guardian_age || ''), canConfirm: row.status === 'pending',
            canSuspend: ['confirmed','verified'].includes(row.status), canRestore: row.status === 'suspended',
            statusLabel: row.status === 'pending' ? '待本人确认' : ['verified','confirmed'].includes(row.status) && row.effective_access === false ? STATUS.denied : STATUS[row.status] || row.status })),
          doctorStatus: STATUS[context.doctor_qualification && context.doctor_qualification.status] || '未核验',
          demonstrationOnly: context.demonstration_only === true,
          relationships: (response.items || []).map(row => ({
            ...row, statusLabel: STATUS[relationshipState(row)] || row.status, scopeLabel: scopeText(row.scope),
            canAccept: row.effective_status !== 'denied' && row.status === 'pending' && row.initiator_user_id !== context.user_id,
            canRevoke: row.can_revoke === undefined ? row.effective_status !== 'denied' && ['pending', 'active'].includes(row.status) : row.can_revoke === true
          })),
          consents: (consentResponse.items || []).map(row => ({
            ...row, purposeLabel: PURPOSE[row.purpose] || row.purpose,
            statusLabel: STATUS[row.effective_status || row.status] || row.status,
            canWithdraw: row.effective_access !== false && ['active', 'granted'].includes(row.status)
          })), loading: false
        })
        return true
      } catch (error) {
        if (!this._isCurrent(lease, version)) return false
        this.setData({ loading: false, patientId: null, patients: [], relationships: [], consents: [], guardians: [],
          errorText: error.message || '授权状态读取失败，请重试' })
        return false
      }
    },
    onTargetEmailInput(event) { if (!this.data.busy) this.setData({ targetEmail: event.detail.value }) },
    onGuardianAge(event) {
      if (this.data.busy) return
      const id = Number(event.currentTarget.dataset.id)
      this.setData({guardians:this.data.guardians.map(row=>row.id===id?{...row,ageInput:event.detail.value}:row)})
    },
    confirmGuardianRelationship(event) {
      const row = this.data.guardians.find(item=>item.id===Number(event.currentTarget.dataset.id))
      const age = Number(row && row.ageInput)
      if (!row || !row.canConfirm) return false
      if (!Number.isInteger(age) || age<18 || age>120) { this.setData({errorText:'请填写监护人的实际年龄（18至120岁）'}); return false }
      return this._perform(`/identity/guardians/${row.id}/confirm-relationship`, {
        expected_revision:row.revision,confirmed:true,guardian_age:age,declaration_version:'guardian-self-declaration-2026-10-19'
      }, '我确认是该儿童的主要监护人，对所填资料负责，并确认注册时的基本使用同意。医生共享、外部AI和研究仍分别确认。', '监护关系已确认，可以进入儿童评估和记录')
    },
    manageGuardian(event) {
      const row=this.data.guardians.find(item=>item.id===Number(event.currentTarget.dataset.id)),action=event.currentTarget.dataset.action
      if (!row || !(['suspend','restore'].includes(action)) || !(action==='suspend'?row.canSuspend:row.canRestore)) return false
      return this._perform(`/identity/guardians/${row.id}/${action}`, {expected_revision:row.revision,review_reference:'监护人本人操作'},
        action==='suspend'?'暂停后停止新的儿童资料访问和提交，相关用途同意也会停止。':'恢复本人监护访问；此前撤回或停止的用途不会自动重新授权，请分别核对。',
        action==='suspend'?'监护访问已暂停':'监护访问已恢复，请核对需要重新确认的用途')
    },
    acceptGuardianSuccessor(event) {
      const row=this.data.guardians.find(item=>item.id===Number(event.currentTarget.dataset.id))
      const confirmation=row && (row.successor_confirmations||[]).find(item=>item.id===Number(event.currentTarget.dataset.confirmation))
      if(!row||!confirmation)return false
      const transfer=confirmation.purpose==='transfer'
      const body={expected_revision:row.revision,review_reference:'现任监护人与新身份双方确认',
        ...(transfer?{new_guardian_user_id:confirmation.user_id,new_guardian_confirmed:true,proof_reference:confirmation.proof_reference}:
          {adult_user_id:confirmation.user_id,adult_confirmed:true,age:confirmation.age})}
      return this._perform(`/identity/guardians/${row.id}/${transfer?'transfer':'adult-conversion'}`,body,
        `确认交接给已本人登录确认的账号 ${confirmation.user_id}。原账号停止访问，新账号需要重新确认基本使用及其他用途。`, '身份交接已完成，原用途同意不会自动继承')
    },
    toggleIdentityConfirmation() { if (!this.data.busy) this.setData({ identityConfirmationVisible: !this.data.identityConfirmationVisible }) },
    onIdentityInput(event) {
      const field = event.currentTarget.dataset.field
      if (!this.data.busy && ['identityRelationshipId', 'identityRevision', 'identityAge', 'identityProof'].includes(field)) this.setData({ [field]: event.detail.value })
    },
    onIdentityPurpose(event) {
      if (!this.data.busy && ['transfer', 'adult_conversion'].includes(event.detail.value)) this.setData({ identityPurpose: event.detail.value })
    },
    confirmNewIdentity() {
      const id = Number(this.data.identityRelationshipId), revision = Number(this.data.identityRevision), age = Number(this.data.identityAge)
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(revision) || revision <= 0 || !Number.isInteger(age) || age < 18 || age > 120 || !this.data.identityProof.trim()) {
        this.setData({ errorText: '请核对原监护人提供的关系编号、版本、关系说明和本人年龄' }); return false
      }
      const action = this.data.identityPurpose === 'transfer' ? 'confirm-transfer' : 'confirm-adult-conversion'
      return this._perform(`/identity/guardians/${id}/${action}`, {
        expected_revision: revision, proof_reference: this.data.identityProof.trim(), terms_version: 'W02-1', age
      }, '由当前账号本人确认承担新的身份；仍需原监护人确认交接。此步骤不授予儿童访问，不继承原监护人的医生共享、AI或研究同意。', '本人身份确认已记录，等待原监护人确认交接')
    },
    onScopeChange(event) {
      if (!this.data.busy) {
        const invitationScope = event.detail.value.filter(value => SCOPE.includes(value))
        this.setData({ invitationScope, scopeOptions: scopeOptions(invitationScope) })
      }
    },
    _confirm(lease, content) {
      return new Promise(resolve => wx.showModal({
        title: '确认授权操作', content,
        success: result => resolve(result.confirm === true && isPatientSessionLeaseCurrent(lease)),
        fail: () => resolve(false)
      }))
    },
    async _perform(url, data, confirmation, successText) {
      if (this.data.busy || this.data.loading) return false
      const lease = capturePatientSessionLease(), version = this._authorizationVersion
      if (!this._isCurrent(lease, version)) return false
      this.setData({ busy: true, errorText: '', statusText: '' })
      try {
        if (confirmation && !await this._confirm(lease, confirmation)) return false
        if (!this._isCurrent(lease, version)) return false
        await request({ url, method: 'POST', data })
        if (!this._isCurrent(lease, version)) return false
        const reloaded = await this.reloadAuthorization()
        if (!isPatientSessionLeaseCurrent(lease)) return false
        this.setData({ statusText: reloaded ? successText : '操作已确认，最新状态读取失败，请刷新核对' })
        return true
      } catch (error) {
        if (this._isCurrent(lease, version)) this.setData({ errorText: error.message || '操作未获确认，请刷新后重试' })
        return false
      } finally {
        if (isPatientSessionLeaseCurrent(lease)) this.setData({ busy: false })
      }
    },
    inviteRelationship() {
      const email = this.data.targetEmail.trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !this.data.invitationScope.length) {
        this.setData({ errorText: '请填写有效邮箱并选择共享范围' }); return false
      }
      const data = { target_email: email, scope: this.data.invitationScope.slice(), purpose: 'clinical_sharing',
        expires_at: new Date(Date.now() + 90 * 86400000).toISOString() }
      if (this.properties.role === 'patient') data.patient_id = this.data.patientId
      return this._perform('/care/relationships/invitations', data,
        `向 ${email} 发出邀请，共享${scopeText(data.scope)}，有效期90天。需要双方确认后生效。`, '邀请已发出，等待对方确认')
    },
    acceptRelationship(event) {
      const row = this.data.relationships.find(item => item.id === Number(event.currentTarget.dataset.id))
      if (!row || !row.canAccept) return false
      return this._perform(`/care/relationships/${row.id}/accept`, { expected_revision: row.revision },
        `确认与 ${row.doctor_name || row.counterparty_email} 共享${row.scopeLabel}；期限${row.expires_at || '以服务端条款为准'}。撤回后停止后续共享。`, '共享关系已确认')
    },
    revokeRelationship(event) {
      const row = this.data.relationships.find(item => item.id === Number(event.currentTarget.dataset.id))
      if (!row || !row.canRevoke) return false
      return this._perform(`/care/relationships/${row.id}/revoke`, { expected_revision: row.revision },
        '撤回后，医生不能继续读取或提交此共享范围的资料。已有本人结果保留，可继续自助或重新邀请医生。', '共享关系已撤回')
    },
    grantBasicUse() {
      if (!this.data.patientId) return false
      return this._perform('/patient/consents', {
        patient_id: this.data.patientId, purpose: 'basic_use', scope: SCOPE.slice(), terms_version: 'W02-1'
      }, '由当前获准身份单独同意基本评估、记录和报告处理。医生共享、外部AI和具体研究仍须分别确认；身份转换不继承原有同意。', '基本使用同意已确认')
    },
    grantExternalAi() {
      if (!this.data.patientId) return false
      return this._perform('/patient/consents', {
        patient_id: this.data.patientId, purpose: 'external_ai', scope: ['profile', 'assessment', 'tracking'],
        terms_version: 'W02-1', expires_at: new Date(Date.now() + 90 * 86400000).toISOString()
      }, '允许外部AI在90天内处理最少必要的结构化评估与记录摘要；不包含原始影像或默认分享私人聊天。你可以撤回，拒绝仍可做日常评估。', '外部AI用途已单独确认')
    },
    withdrawConsent(event) {
      const row = this.data.consents.find(item => item.id === Number(event.currentTarget.dataset.id))
      if (!row || !row.canWithdraw) return false
      return this._perform(`/patient/consents/${row.id}/withdraw`, { expected_revision: row.revision },
        `撤回${row.purposeLabel}同意，停止此用途的后续处理。已完成研究产物不能承诺即时消除；历史按保留规则处理。`, '用途同意已撤回')
    }
  }
})
