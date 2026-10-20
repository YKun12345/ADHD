const { request }=require('../../utils/request')
const { protectPatientPage }=require('../../utils/patient-page')
const { hasValidAnySession }=require('../../utils/role-session')
const { capturePatientSessionLease,isPatientSessionLeaseCurrent,summarizePatientData,endPatientSession,reLaunchSafely }=require('../../utils/session-privacy')
const { itemsFor,entriesFor,entryUrl }=require('../../utils/workspace-navigation')
const { targetUrl }=require('../../utils/agent-actions')
const positive=value=>Number.isSafeInteger(value)&&value>0
const ENTRY_ICONS={assessment:'scale',self_report:'report',care_pathway:'pathway',education:'education',cycle:'calendar',followup_summary:'tracking',legacy_records:'folder',shared_messages:'ai',tasks:'plan',attention:'plan',queue:'upload',legacy_messages:'message',agent:'ai',privacy:'shield',notifications:'bell',server:'settings'}
const COMPANION_KEYS={assessments:'assessments',records:'care-cycles',communication:'shared-messages',account:'privacy-settings'}
const LABELS={draft:'待发布',active:'进行中',evidence_ready:'材料已齐',under_review:'等待审核',reviewed:'医生已复核',closed_self:'自助已完成',suspended:'已暂停',cancelled:'已取消',closed:'已结束',awaiting_review:'等待阶段复核',ended:'已结束',scheduled:'待开始'}
const empty=()=>({profiles:[],profileIndex:-1,patientId:0,assessments:[],cycles:[],questionActions:[],accountName:'',accountEmail:'',pendingCount:0,
  summary:null,loading:false,busy:false,errorText:''})
Page(protectPatientPage({
  data:{...empty(),role:'',section:'',title:'',entryItems:[],companionPageKey:''},
  onLoad(options={}) {
    const user=wx.getStorageSync('current_user')||{}
    this._active=true;this._lease=capturePatientSessionLease();this._actor=user.id;this._role=user.role
    this._preferredId=/^\d+$/.test(String(options.patient_id))?Number(options.patient_id):0
    this._invalidProfile=options.patient_id!==undefined&&!positive(this._preferredId)
    const section=itemsFor(user.role).find(row=>row.key===options.section),entries=entriesFor(user.role,options.section)
    this._invalidSection=!section||!entries.length
    this.setData({role:user.role,section:options.section||'',title:section?.label||'功能分组',companionPageKey:options.section==='account'&&user.role==='researcher'?'doctor-guide-settings':COMPANION_KEYS[options.section]||'',entryItems:entries.map((row,index)=>({...row,icon:ENTRY_ICONS[row.key]||'plan',tone:(options.section==='assessments'||options.section==='communication')&&index===0?'focus':row.key==='education'||row.key==='legacy_records'||row.key==='legacy_messages'||(options.section==='communication'&&row.key==='queue')?'archive':'white',layout:options.section==='assessments'&&(index===1||index===2)||options.section==='communication'&&index>=2?'tile':'wide',preview:options.section==='assessments'&&index===0?'ring':options.section==='records'&&index<2?'chart':''}))})
    return this.reload()
  },
  onShow(){if(this._ended)return false;this._active=true;return this.reload()},
  onHide(){this._active=false;this._epoch=(this._epoch||0)+1;this.setData(empty())},
  onUnload(){this._ended=true;this.onHide()},
  onPatientSessionEnded(){this._ended=true;this.onHide()},
  usable(){const user=wx.getStorageSync('current_user')||{};const ok=!this._ended&&this._active&&hasValidAnySession()&&user.id===this._actor&&user.role===this._role&&isPatientSessionLeaseCurrent(this._lease);if(!ok&&this._active)this.onPatientSessionEnded();return ok},
  current(epoch){return this.usable()&&this._epoch===epoch},
  async reload(){
    if(!this.usable()||this.data.loading||this.data.busy)return false
    if(this._invalidSection||this._invalidProfile){this.setData({errorText:'当前功能或档案编号不在可用范围，请从底部导航进入。'});return false}
    const epoch=this._epoch=(this._epoch||0)+1;this.setData({loading:true,errorText:'',assessments:[],cycles:[],questionActions:[],summary:null})
    try{
      if(this.data.section==='account'){
        const user=await request({url:'/auth/me'});if(!this.current(epoch))return false
        if(user.id!==this._actor||user.role!==this._role)throw new Error('账户来源与当前身份不一致。')
        this.setData({accountName:user.full_name||user.username||'我的账号',accountEmail:user.email||'',pendingCount:summarizePatientData().pendingCount,loading:false});return true
      }
      const response=await request({url:this._role==='researcher'?'/doctor/my_patients':'/identity/context'});if(!this.current(epoch))return false
      const source=this._role==='researcher'?response.items:response.accessible_patients
      if(!Array.isArray(source)||source.some(row=>!positive(row.patient_id))||new Set(source.map(row=>row.patient_id)).size!==source.length)throw new Error('实际可用档案列表不完整。')
      const profiles=source.map(row=>({patient_id:row.patient_id,label:this._role==='researcher'&&!(row.allowed_scope||[]).includes('profile')?`共享档案 ${row.patient_id}`:row.display_name||row.patient_name||`档案 ${row.patient_id}`}))
      const index=this._preferredId?profiles.findIndex(row=>row.patient_id===this._preferredId):profiles.length===1?0:-1
      if(this._preferredId&&index<0)throw new Error('该档案不在当前账号的实际授权范围内。')
      const pid=index>=0?profiles[index].patient_id:0
      this.setData({profiles,profileIndex:index,patientId:pid})
      if(!pid){this.setData({loading:false});return true}
      this._preferredId=pid
      if(this.data.section==='assessments'){
        const value=await request({url:`/care/assessments?patient_id=${pid}`});if(!this.current(epoch))return false
        if(!Array.isArray(value.items)||value.items.some(row=>row.patient_id!==pid||!positive(row.id)))throw new Error('评估来源与所选档案不一致。')
        this.setData({assessments:value.items.map(row=>({...row,statusText:LABELS[row.processing_status]||LABELS[row.status]||'查看实际状态'}))})
      }else if(this.data.section==='records'){
        const value=await request({url:`/care/cycles?patient_id=${pid}`});if(!this.current(epoch))return false
        if(!Array.isArray(value.items)||value.items.some(row=>row.patient_id!==pid||!positive(row.id)))throw new Error('日期周期来源与所选档案不一致。')
        this.setData({cycles:value.items.map(row=>({...row,statusText:LABELS[row.processing_status]||LABELS[row.status]||'查看实际状态'}))})
      }else{
        if(this._role==='patient'){
          const value=await request({url:`/agent/actions?patient_id=${pid}`});if(!this.current(epoch))return false
          if(value.actor_user_id!==this._actor||value.patient_id!==pid||!Array.isArray(value.items))throw new Error('具体补问来源不一致。')
          const rows=value.items.filter(row=>row.kind==='answer_questions')
          for(const row of rows){if(!positive(row.id)||row.actor_user_id!==this._actor||row.patient_id!==pid||row.status!=='available')throw new Error('补问状态有变化。');targetUrl(row.target,{role:this._role,patientId:pid})}
          this.setData({questionActions:rows})
        }
      }
      this.setData({loading:false});return true
    }catch(error){if(this.current(epoch))this.setData({loading:false,assessments:[],cycles:[],questionActions:[],summary:null,errorText:error.message||'暂未读取成功，请重试。'});return false}
  },
  selectProfile(event){if(!this.usable()||this.data.loading||this.data.busy)return false;const row=this.data.profiles[Number(event.detail.value)];if(!row)return false;this._preferredId=row.patient_id;return this.reload()},
  openEntry(event){if(!this.usable()||this.data.loading||this.data.busy)return false;const url=entryUrl(this._role,this.data.section,event.currentTarget.dataset.key,this.data.patientId);if(!url){wx.showToast?.({title:this._role==='researcher'?'请先选择要服务的用户':'请先选择本人或儿童档案',icon:'none'});return false}wx.navigateTo({url});return true},
  openAssessment(event){if(!this.usable()||this.data.loading||this.data.busy)return false;const id=Number(event.currentTarget.dataset.id);if(!this.data.assessments.some(row=>row.id===id&&row.patient_id===this.data.patientId))return false;wx.navigateTo({url:`/pages/assessments/index?patient_id=${this.data.patientId}&assessment_id=${id}`});return true},
  openCycle(event){if(!this.usable()||this.data.loading||this.data.busy)return false;const id=Number(event.currentTarget.dataset.id);if(!this.data.cycles.some(row=>row.id===id&&row.patient_id===this.data.patientId))return false;wx.navigateTo({url:`/pages/care-cycles/index?patient_id=${this.data.patientId}&cycle_id=${id}`});return true},
  async openQuestion(event){
    if(!this.usable()||this.data.loading||this.data.busy)return false
    const row=this.data.questionActions.find(value=>value.id===Number(event.currentTarget.dataset.id));if(!row)return false
    const epoch=this._epoch=(this._epoch||0)+1;this.setData({busy:true,errorText:''})
    try{const value=await request({url:`/agent/actions/${row.id}/resolve`,method:'POST',data:{patient_id:this.data.patientId,expected_action_digest:row.action_digest}});if(!this.current(epoch))return false
      if(value.action_id!==row.id||value.patient_id!==this.data.patientId||value.action_digest!==row.action_digest||value.revalidated!==true||JSON.stringify(value.target)!==JSON.stringify(row.target))throw new Error('补问已有变化，请刷新后继续。')
      this.setData({busy:false});wx.navigateTo({url:targetUrl(value.target,{role:this._role,patientId:this.data.patientId})});return true
    }catch(error){if(this.current(epoch))this.setData({busy:false,questionActions:[],errorText:error.message});return false}
  },
  logout(){
    if(!this.usable()||this.data.busy)return false
    const finish=()=>{if(!this.usable())return;endPatientSession({includePatientData:true});this.onPatientSessionEnded();reLaunchSafely('/pages/login/index','退出后请重新打开登录页')}
    if(summarizePatientData().pendingCount>0)wx.showModal({title:'还有待确认记录',content:'退出会清除本机未确认原件，可先到“发送与恢复”核对。确定退出并清除吗？',confirmText:'退出并清除',success:result=>{if(result.confirm)finish()}})
    else finish()
    return true
  }
},()=>hasValidAnySession()))
