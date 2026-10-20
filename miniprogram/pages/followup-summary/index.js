const { request } = require('../../utils/request')
const { fetchFollowupSummary } = require('../../utils/followup-summary')
const { protectPatientPage } = require('../../utils/patient-page')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease,isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
const positive=value=>Number.isInteger(Number(value))&&Number(value)>0
Page(protectPatientPage({
 data:{patientId:0,summary:null,busy:false,errorText:''},
 onLoad(options={}){const actor=wx.getStorageSync('current_user')||{};this._actor=actor.id;this._role=actor.role;this._lease=capturePatientSessionLease();this._active=true;this.setData({patientId:positive(options.patient_id)?Number(options.patient_id):0});return this.reload()},
 onShow(){if(!this._ended){this._active=true;return this.reload()}},
 onHide(){this._active=false;this._epoch=(this._epoch||0)+1;this.setData({summary:null,busy:false,errorText:''})},
 onUnload(){this._ended=true;this.onHide()},
 usable(){const actor=wx.getStorageSync('current_user')||{};return !this._ended&&this._active&&hasValidAnySession()&&actor.id===this._actor&&actor.role===this._role&&isPatientSessionLeaseCurrent(this._lease)},
 current(epoch){return this.usable()&&epoch===this._epoch},
 async reload(){if(!this.usable()||this.data.busy)return false;const epoch=this._epoch=(this._epoch||0)+1;this.setData({summary:null,busy:true,errorText:''});
  try{let pid=this.data.patientId;if(!pid){if(this._role!=='patient')throw Error('请从实际患者详情进入。');const context=await request({url:'/identity/context'});if(!this.current(epoch))return false;
    const profiles=context.accessible_patients||[];if(profiles.length!==1)throw Error('请从具体档案进入长期总结。');pid=profiles[0].patient_id;this.setData({patientId:pid})}
   const summary=await fetchFollowupSummary(pid);if(!this.current(epoch))return false;this.setData({summary,busy:false});return true;
  }catch(error){if(this.current(epoch))this.setData({summary:null,busy:false,errorText:error.message||'暂未读取实际随访资料。'});return false}},
 openSource(event){if(!this.usable())return;const type=event.currentTarget.dataset.type,index=Number(event.currentTarget.dataset.index),summary=this.data.summary;
  const row=type==='measurement'?summary?.measurements[index]:summary?.cycles[index];if(!row)return;
  if(type==='measurement'&&row.patient_id===this.data.patientId&&positive(row.assessment_id))wx.navigateTo({url:`/pages/assessments/index?patient_id=${this.data.patientId}&assessment_id=${row.assessment_id}`});
  else if(type==='cycle'&&positive(row.cycle_id))wx.navigateTo({url:`/pages/care-cycles/index?patient_id=${this.data.patientId}&cycle_id=${row.cycle_id}`})},
 openStep(event){if(!this.usable())return;const step=this.data.summary?.nextSteps[Number(event.currentTarget.dataset.index)],target=step?.target;
  if(target&&target.patient_id===this.data.patientId&&positive(target.cycle_id)&&['care-cycles','cycle-review'].includes(target.page))wx.navigateTo({url:`/pages/${target.page}/index?patient_id=${this.data.patientId}&cycle_id=${target.cycle_id}`})}
},()=>hasValidAnySession()))
