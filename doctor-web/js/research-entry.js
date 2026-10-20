/* Discover research only from the server's current project/reviewer scope. */
(() => {
 'use strict';
 const target=document.querySelector('[data-research-entry]'),guard=window.SessionGuard,session=guard?.captureSession();
 if(!target||!session?.token||session.role!=='researcher')return;
 let stopped=false;const clear=()=>{stopped=true;target.replaceChildren();target.hidden=true;};
 guard.onInvalidated(clear);window.addEventListener('pagehide',clear);document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
 (async()=>{
  try{
   guard.assertCurrentSession(session);
   const response=await fetch(resolveApiBaseUrl()+'/federated/projects',{headers:{Authorization:`Bearer ${session.token}`},credentials:'include'});
   const data=await response.json();guard.assertCurrentSession(session);
   if(stopped||document.hidden||!response.ok||!Array.isArray(data.projects)||!Array.isArray(data.reviewer_institutions)||(!data.projects.length&&!data.reviewer_institutions.length))return;
   const link=document.createElement('a');link.href='federated_workbench.html';link.textContent='合成联邦研究工作台';link.className='btn-outline';
   const notice=document.createElement('p');notice.textContent='你已获具体项目成员权限或机构审核权限。仅开放合成研究。';target.append(notice,link);target.hidden=false;
  }catch(_){clear();}
 })();
})();
