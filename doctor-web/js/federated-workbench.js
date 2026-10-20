(() => {
 'use strict';
 const {makePage,node,input,button}=window.ClinicalBusiness,page=makePage('federated');if(!page)return;
 const base='/federated',labels={pending:'待批准',active:'已批准',approved:'已批准',revoked:'已撤销',authority_invalid:'原准入已失效'};
 const stamp=days=>new Date(Date.now()+days*86400000).toISOString();
 const field=(area,label,value='',multi=false,type='text')=>{const row=input(label,multi,multi?4000:255,type);row.field.value=value;area.append(row.wrapper);return row.field;};
 const submit=(route,payload,label)=>page.submit({route:base+route,queryRoute:base+'/submissions/',idField:'client_request_id',
  payload:{client_request_id:page.newId('fed'),...payload},ackType:'federated',label,confirm:'确认'+label+'？仅处理当前具体项目或节点，权限由服务端核对。'});
 const action=(route,revision,extra,label)=>{
  const reason=prompt('请填写这次'+label+'的实际理由：');if(!reason?.trim())return;
  return submit(route,{expected_revision:revision,confirmed:true,reason:reason.trim(),...extra},label);
 };
 page.reload=async()=>{
  window.FederatedExperiments?.reset();const ticket=page.next();page.researchTicket=ticket;await page.pendingView();const data=await page.request(base+'/projects');if(!page.current(ticket))return;
  const controls=page.area('clinicalInputs'),history=page.area('clinicalHistory');controls.replaceChildren();history.replaceChildren();
  if(data.reviewer_institutions.length){
   const create=node('details');create.append(node('summary','创建合成研究项目'));controls.append(create);
   const institution=node('select');institution.setAttribute('aria-label','所属机构');for(const id of data.reviewer_institutions){const option=node('option',id);option.value=id;institution.append(option);}create.append(institution);
   const name=field(create,'项目名称'),purpose=field(create,'具体研究用途','',true),contract=field(create,'数据契约','synthetic-roi-v1'),expiry=field(create,'有效期（含时区）',stamp(30));
   create.append(button('创建项目',()=>submit('/projects',{institution_id:institution.value,name:name.value,purpose:purpose.value,data_contract:contract.value,mode:'synthetic',expires_at:expiry.value},'创建合成项目')));
   const enrollment=node('details');enrollment.append(node('summary','登记节点公钥'));controls.append(enrollment);
   const ni=field(enrollment,'节点机构',data.reviewer_institutions[0]),nid=field(enrollment,'节点编号（节点本地生成，可留空）'),nn=field(enrollment,'节点名称'),pem=field(enrollment,'Ed25519公钥（PEM）','',true),compat=field(enrollment,'节点兼容版本','flower-1.23/secaggplus-v1');
   enrollment.append(button('登记公钥',()=>submit('/nodes/enrollment',{institution_id:ni.value,...(nid.value.trim()?{node_id:nid.value.trim()}:{}),name:nn.value,public_key_pem:pem.value,compatibility:compat.value},'登记节点公钥')));
  }
  history.append(node('h2','当前可访问项目'));
  if(!data.projects.length)history.append(node('p','暂无当前获准的研究项目。普通医生和技术账号不自动获得研究权限。'));
  for(const summary of data.projects){
   const project=await page.request(base+'/projects/'+summary.id);if(!page.current(ticket))return;
   const admin=data.reviewer_institutions.includes(project.institution_id),card=node('article');card.dataset.projectId=project.id;
   card.append(node('h3',`${project.name} · 项目${project.id} · ${labels[project.status]||project.status}`),node('p',project.purpose),node('p',`合成研究 · ${project.institution_id} · 有效期 ${project.expires_at}`));
   if(admin&&project.status!=='revoked'){
    if(project.status==='pending')card.append(button('批准项目',()=>action(`/projects/${project.id}/approve`,project.revision,{},'批准项目')));
    card.append(button('撤销项目',()=>action(`/projects/${project.id}/revoke`,project.revision,{},'撤销项目')));
   }
   if(admin&&project.status==='active'){
    const member=node('details');member.append(node('summary','授予具体成员权限'));card.append(member);
    const uid=field(member,'成员账号编号','',false,'number'),expiry=field(member,'成员有效期（不得超过项目）',project.expires_at),permissions=node('select');permissions.setAttribute('aria-label','成员权限');
    for(const [value,label]of[['view','查看项目'],['experiment','查看并操作实验']]){const option=node('option',label);option.value=value;permissions.append(option);}member.append(permissions);
    member.append(button('授予成员权限',()=>action(`/projects/${project.id}/members`,project.revision,{user_id:Number(uid.value),permissions:[permissions.value],expires_at:expiry.value},'授予成员权限')));
    for(const m of project.members){const row=node('p',`成员${m.user_id} · ${labels[m.status]||m.status} · ${m.permissions.join(' / ')}`);if(m.status==='active')row.append(button('撤销此成员',()=>action(`/projects/${project.id}/members/${m.user_id}/revoke`,project.revision,{},'撤销具体成员')));member.append(row);}
    const available=data.nodes.filter(n=>n.status==='approved'&&!project.nodes.some(v=>v.id===n.id&&v.effective_status!=='revoked'));
    if(available.length){const select=node('select');select.setAttribute('aria-label','项目节点');for(const n of available){const option=node('option',n.name);option.value=n.id;select.append(option);}card.append(select,button('加入固定等权白名单',()=>action(`/projects/${project.id}/nodes`,project.revision,{node_id:select.value},'加入项目节点')));}
    const foreign=field(card,'合作节点编号（由对方机构提供）');card.append(button('邀请合作节点',()=>action(`/projects/${project.id}/nodes`,project.revision,{node_id:foreign.value.trim()},'邀请合作机构节点，等待对方确认')));
   }
   for(const n of project.nodes){const row=node('p',`节点 ${n.name} · 权重${n.weight} · ${labels[n.effective_status]||n.effective_status} · ${n.identity_verified?'近期签名心跳已核验':'近期签名心跳尚未核验'} · ${n.runtime_admitted?'运行准入已通过':'实际运行条件由实验预检核对'}`);if(admin&&n.effective_status!=='revoked')row.append(button('撤销此项目节点权限',()=>action(`/projects/${project.id}/nodes/${n.link_id}/revoke`,n.link_revision,{},'撤销此项目节点权限')));card.append(row);}
   const auditView=node('pre');auditView.hidden=true;card.append(button('读取项目审计',()=>page.run(async()=>{const audit=await page.request(base+`/projects/${project.id}/audit`);if(!page.current(ticket))return;auditView.hidden=false;auditView.textContent=JSON.stringify(audit,null,2);})),auditView);history.append(card);
   if(project.status==='active'&&window.FederatedExperiments)await window.FederatedExperiments.attach(page,project,admin,submit,action,card);
  }
  for(const invitation of data.node_invitations){const card=node('article');card.append(node('h3',`合作邀请：${invitation.project_name}`),node('p',`${invitation.project_institution_id} · ${invitation.purpose} · 节点 ${invitation.node_name}`),button('所属机构明确接受',()=>action(`/projects/${invitation.project_id}/nodes/${invitation.id}/approve`,invitation.revision,{},'接受此具体项目的节点邀请')),button('拒绝并撤销邀请',()=>action(`/projects/${invitation.project_id}/nodes/${invitation.id}/revoke`,invitation.revision,{},'拒绝节点邀请')));history.append(card);}
  if(data.nodes.length)history.append(node('h2','所属机构节点'));
  for(const n of data.nodes){const card=node('article');card.dataset.nodeId=n.id;card.append(node('h3',`${n.name} · ${labels[n.status]||n.status}`),node('p',n.public_key_fingerprint),node('p',n.identity_verified?`节点签名已核验 · ${n.last_heartbeat_at}`:'尚无近期有效的节点签名心跳'));if(n.status==='pending')card.append(button('批准节点',()=>action(`/nodes/${n.id}/approve`,n.revision,{},'批准节点')));if(n.status!=='revoked')card.append(button('撤销节点',()=>action(`/nodes/${n.id}/revoke`,n.revision,{},'撤销节点')));history.append(card);}
  if(!page.pending)page.say(`已读取${data.projects.length}个项目。真实数据训练未开放。`);
 };
 page.run(page.reload);
})();
