/* Local synthetic research controls; every displayed state comes from the scoped API. */
(() => {
 'use strict';
 const {node,input,button}=window.ClinicalBusiness;
 const labels={draft:'草稿',ready:'预检通过',queued:'等待后台执行',running:'后台执行中',stopping:'正在安全停止',validating:'实际候选验证中',completed:'实验已完成',failed:'失败',cancelled:'已停止',budget_exhausted:'预算不足'};
 const live=new Set();
 const reset=()=>{for(const stop of live)stop();live.clear();};
 const json=value=>JSON.stringify(value,null,2);
 const details=(title,value)=>{const host=node('details');host.append(node('summary',title),node('pre',json(value)));return host;};
 const select=(host,label,options)=>{const wrap=node('label',label),field=node('select');field.setAttribute('aria-label',label);for(const [value,text]of options){const option=node('option',text);option.value=value;field.append(option);}wrap.append(field);host.append(wrap);return field;};
 const checkList=(response,key)=>{if(!response||!Array.isArray(response[key]))throw Error('研究返回结构不一致，请重新读取。');return response[key];};
 const positive=value=>Number.isSafeInteger(value)&&value>0;
 async function attach(page,project,admin,submit,action,card){
  const ticket=page.researchTicket,route=`/federated/projects/${project.id}`;
  let stopped=false,timer,polling=false;const active=()=>!stopped&&page.current(ticket)&&!document.hidden&&card.isConnected;
  const stop=()=>{stopped=true;clearTimeout(timer);};live.add(stop);
  const section=node('section');section.className='research-experiments';section.setAttribute('aria-label',`项目${project.id}合成研究实验`);card.append(section);
  section.append(node('h4','合成联邦实验'),node('p','仅合成研究；固定 HGST 编码器不受本轮差分隐私保护。DP 仅覆盖逐患者分类器更新；采用各机构保守顺序组合预算和普通随机源，不具备安全随机源保证。已预留和未确认消耗不会因失败、停止或换项目退还。候选仅供实验，不能临床激活。'));
  const own=project.members.find(m=>m.user_id===page.session.accountId&&m.status==='active'&&Date.parse(m.expires_at)>Date.now());
  const canOperate=project.status==='active'&&(admin||own?.permissions.includes('experiment'));
  const privacyView=node('div'),form=node('details'),records=node('div');section.append(privacyView);
  if(canOperate){
   form.dataset.experimentCreate=String(project.id);form.append(node('summary','新建冻结配置的实验'));section.append(form);
   try{
    const response=await page.request(route+'/bases');if(!active())return;const bases=checkList(response,'items');
    if(!bases.length)form.append(node('p','暂无当前来源和输入契约均已核验的研究基座。先完成研究基座登记与审核。'));
    else{
     const base=select(form,'研究基座',bases.map(b=>[String(b.id),`${b.version||b.label||'研究基座'} · ${b.id} · SHA256 ${b.artifact_sha256}`]));
     const source=node('p');const updateSource=()=>{const b=bases.find(v=>String(v.id)===base.value);source.textContent=`原基座 SHA256：${b.artifact_sha256}\n输入契约：${b.input_contract_digest}`;};base.addEventListener('change',updateSource);updateSource();form.append(source);
     const roster=node('fieldset');roster.append(node('legend','恰好选择三个不同机构、已获项目批准的节点'));
     for(const n of project.nodes.filter(v=>v.effective_status==='approved')){const wrap=node('label'),box=node('input');box.type='checkbox';box.value=n.id;box.setAttribute('aria-label',`选择节点 ${n.id}`);wrap.append(box,document.createTextNode(`${n.name} · ${n.institution_id} · ${n.id} · ${n.identity_verified?'近期签名心跳已核验':'近期心跳尚未核验'} · 准入仍由预检核对`));roster.append(wrap);}form.append(roster);
     const rounds=input('计划轮数',false,1,'number');rounds.field.min='1';rounds.field.max='5';rounds.field.step='1';rounds.field.value='2';form.append(rounds.wrapper);
     const mode=select(form,'实验保护模式',[['dp_secagg','逐患者 DP + 原生 SecAgg+（合成）'],['synthetic_plaintext','无隐私保护的明文合成对照']]);
     form.append(node('p','明文对照只接受合成节点资料，不能指定患者同意，也不具有DP或安全聚合保护。启动仅在你明确确认后提交后台；页面不会自动训练。'));
     const consents=input('指定研究同意记录编号（可选，逗号分隔）');form.append(consents.wrapper,node('p','合成实验可不选择同意；如指定，后端会核对每份原项目、同意版本、范围及撤回状态。'));
     form.append(button('创建冻结配置实验',()=>{
      const ids=[...roster.querySelectorAll('input:checked')].map(v=>v.value),count=Number(rounds.field.value),text=consents.field.value.trim();
      const consentIds=text?text.split(/[,，\s]+/).map(v=>Number(v)):[];
      if(ids.length!==3||new Set(ids).size!==3||new Set(ids.map(id=>project.nodes.find(n=>n.id===id).institution_id)).size!==3)return page.say('请选择三个不同机构的具体项目节点。');
      if(!Number.isSafeInteger(count)||count<1||count>5)return page.say('计划轮数必须为1到5的整数。');
      if(consentIds.some(v=>!positive(v))||new Set(consentIds).size!==consentIds.length)return page.say('请填写互不重复的正整数研究同意记录编号。');
      if(mode.value==='synthetic_plaintext'&&consentIds.length)return page.say('明文合成对照不能附带患者研究同意记录。');
      return submit(`/projects/${project.id}/experiments`,{base_model_version_id:Number(base.value),node_ids:ids,rounds:count,mode:mode.value,consent_record_ids:consentIds},'创建 DP + SecAgg+ 合成实验');
     }));
    }
   }catch(error){if(active())form.append(node('p',`研究基座读取未完成：${error.message}`));}
  }else section.append(node('p','当前为查看权限；创建、预检、启动和停止需要本项目明确的实验权限。'));
  section.append(records);
  const views=new Map();
  function experimentView(e){
   let view=views.get(e.id);if(view)return view;
   const host=node('article');host.dataset.experimentId=e.id;const state=node('div'),rounds=node('div'),candidate=node('div');host.append(state,rounds,candidate);records.append(host);
   view={host,state,rounds,candidate,candidateKey:null};views.set(e.id,view);return view;
  }
  async function candidates(view,e){
   const response=await page.request(route+'/models');if(!active())return;
   const candidate=checkList(response,'items').find(v=>v.experiment_id===e.id);
   if(!candidate){if(!view.candidateKey)view.candidate.textContent='尚无通过实际验证的实验候选。';return;}
   if(!positive(candidate.model_version_id)||candidate.research_only!==true||candidate.clinical_activation_allowed!==false)throw Error('候选研究范围不一致，已停止显示。');
   const key=`${candidate.model_version_id}:${candidate.revision}:${candidate.published}`;if(view.candidateKey===key)return;
   view.candidateKey=key;view.candidate.replaceChildren(node('h5',`研究候选 ${candidate.model_version_id} · ${candidate.published?'已明确实验发布':'尚未实验发布'}`),node('p',`候选 SHA256：${candidate.artifact_sha256}\n${candidate.mode==='synthetic_plaintext'?'无隐私保护的明文合成对照':'DP + SecAgg+ 分类器研究候选'}；不可临床激活。`),details('候选验证和保护范围明细',{validation:candidate.validation,privacy:candidate.privacy,encoder_origin:candidate.encoder_origin}));
   if(admin&&!candidate.published)view.candidate.append(button('DAC明确发布此实验候选',()=>action(`/projects/${project.id}/models/${candidate.model_version_id}/publish`,candidate.revision,{},'发布此指定合成实验候选')));
   if(candidate.published){
    const file=input('合成 ROI 预览文件（.npz）',false,255,'file');file.field.accept='.npz';const wrap=node('label'),confirmed=node('input');confirmed.type='checkbox';confirmed.setAttribute('aria-label','确认仅上传合成ROI');wrap.append(confirmed,document.createTextNode('确认文件只含合成 ROI（roi、labels、synthetic=true），不含真实患者影像。'));
    const result=node('div');view.candidate.append(file.wrapper,wrap,button('使用指定候选预览合成ROI',()=>page.run(async()=>{
     const selected=file.field.files?.[0];if(!confirmed.checked||!selected||!selected.name.toLowerCase().endsWith('.npz'))throw Error('请选择合成 .npz 文件并明确确认合成来源。');
     const body=new FormData();body.append('file',selected);body.append('confirmed_synthetic','true');
     window.SessionGuard.assertCurrentSession(page.session);
     const response=await fetch(resolveApiBaseUrl()+route+`/models/${candidate.model_version_id}/preview`,{method:'POST',headers:{Authorization:`Bearer ${page.session.token}`},credentials:'include',body});
     const preview=await response.json();window.SessionGuard.assertCurrentSession(page.session);if(!active())return;
     if(!response.ok)throw Error(typeof preview.detail==='string'?preview.detail:'合成预览未通过输入、模型或原授权核验。');
     if(preview.model_version_id!==candidate.model_version_id||preview.artifact_sha256!==candidate.artifact_sha256||preview.research_only!==true)throw Error('预览与指定候选原摘要不一致。');
     result.replaceChildren(node('p','指定候选实际推理结果（仅合成研究）'),node('pre',json(preview)));file.field.value='';
    })),result);
   }
  }
  async function refresh(){
   if(!active())return;
   const listed=await page.request(route+'/experiments');if(!active())return;const items=checkList(listed,'items');
   if(!items.length&&!records.children.length)records.append(node('p','尚无实验；不会自动创建或自动启动。'));
   if(items.length&&!views.size)records.replaceChildren();
   for(const summary of items){
    const e=await page.request(`/federated/experiments/${encodeURIComponent(summary.id)}`);if(!active())return;
    if(e.project_id!==project.id||e.id!==summary.id||!positive(e.revision))throw Error('实验状态与当前项目或版本不一致。');
    const view=experimentView(e),config=e.configuration;view.host.dataset.experimentStatus=e.status;
    view.state.replaceChildren(node('h5',`实验 ${e.id} · ${labels[e.status]||e.status} · 版本 ${e.revision}`),node('p',`${e.completed_rounds} / ${config.rounds} 轮已提交 · ${config.mode==='dp_secagg'?'逐患者 DP + SecAgg+（合成）':'明文合成对照：没有 DP 或安全聚合保护'}\n基座 ${config.base_model_version_id} · 节点 ${config.node_ids.join('、')}\n冻结配置摘要：${e.configuration_digest}`));
    if(e.last_error)view.state.append(node('p','实际失败或停止原因：'+(typeof e.last_error==='string'?e.last_error:json(e.last_error))));
    if(e.preflight)view.state.append(details('查看预检明细',e.preflight));
    if(canOperate){
     if(['draft','ready'].includes(e.status))view.state.append(button('运行真实预检',()=>action(`/experiments/${e.id}/preflight`,e.revision,{},'执行真实节点、模型和预算预检')));
     if(e.status==='ready')view.state.append(button('启动后台实验',()=>action(`/experiments/${e.id}/start`,e.revision,{},'启动当前冻结配置的合成实验')));
     if(!['completed','failed','cancelled','budget_exhausted'].includes(e.status))view.state.append(button('请求安全停止',()=>action(`/experiments/${e.id}/stop`,e.revision,{},'安全停止实验（保留已消耗和预留预算）')));
    }
    const rounds=await page.request(`/federated/experiments/${encodeURIComponent(e.id)}/rounds`);if(!active())return;
    if(rounds.experiment_id!==e.id)throw Error('轮次记录与当前实验不一致。');
    const attempts=checkList(rounds,'items');view.rounds.replaceChildren(attempts.length?details(`查看 ${attempts.length} 次实际轮次记录`,attempts):node('p','尚无已执行轮次。'));
    try{await candidates(view,e);}catch(error){if([401,403].includes(error.status))throw error;if(active()&&!view.candidateKey)view.candidate.textContent='候选读取未完成：'+error.message;}
   }
   try{const privacy=await page.request(route+'/privacy');if(!active())return;privacyView.replaceChildren(node('h5','跨项目保守组合预算（后端实际账本）'),node('p',`当前 ε=${privacy.overall?.epsilon} / ${privacy.maximum_epsilon}；δ=${privacy.overall?.delta}。明文对照不受该预算保护。`),details('查看预算和保护范围明细',privacy));}
   catch(error){if([401,403].includes(error.status))throw error;if(active())privacyView.textContent='实际预算尚未读到：'+error.message;}
  }
  async function poll(){
   if(!active()){stop();return;}
   if(!page.pending&&!page.shell.hasAttribute('aria-busy')&&!polling){
    polling=true;try{await refresh();}catch(error){if(active()){
     if([401,403].includes(error.status)){card.replaceChildren(node('p','当前项目原权限已失效，已清空详情。请重新读取。'));stop();}
     else page.say('后台状态读取未完成，当前填写内容保留：'+error.message);
    }}finally{polling=false;}
   }
   if(active())timer=setTimeout(poll,5000);
  }
  await refresh();if(active())timer=setTimeout(poll,5000);
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});window.addEventListener('pagehide',reset);window.SessionGuard?.onInvalidated(reset);
 window.FederatedExperiments={attach,reset};
})();
