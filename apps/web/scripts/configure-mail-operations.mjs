const [domain, owner] = process.argv.slice(2);
if (!domain || !owner || !/^[a-z0-9.-]+$/.test(domain)) throw Error("Usage: node configure-mail-operations.mjs <domain> <owner-email>");
import { PrismaClient } from "@prisma/client";
const p=new PrismaClient();
async function j(calls){const r=await fetch(process.env.STALWART_URL+"/jmap",{method:"POST",headers:{Authorization:"Bearer "+process.env.STALWART_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],methodCalls:calls})});const s=await r.json();for(const[n,b]of s.methodResponses)if(n==="error"||b.notCreated||b.notUpdated)throw Error(JSON.stringify({method:n,...b}));return s.methodResponses;}
(async()=>{
 const box=await p.mailbox.findUniqueOrThrow({where:{address:`postmaster@${domain}`},include:{domain:true}});
 const user=await p.user.findUniqueOrThrow({where:{email:owner}});
 const membership=await p.organizationMember.findFirst({where:{organizationId:box.organizationId,userId:user.id}});if(!membership)throw Error("Owner not in org");
 await p.userMailbox.upsert({where:{userId_mailboxId:{userId:user.id,mailboxId:box.id}},create:{userId:user.id,mailboxId:box.id,organizationId:box.organizationId,isPrimary:false},update:{}});
 for(const local of ["abuse","dmarc","reply"]){
  const source=local+"@"+domain;
  if(await p.emailAlias.findUnique({where:{organizationId_source:{organizationId:box.organizationId,source}}}))continue;
  const res=await j([["x:MailingList/set",{create:{alias:{name:local,domainId:box.domain.stalwartDomainId,recipients:{[box.address]:true}}}},"c"]]);const id=res[0][1].created?.alias?.id;if(!id)throw Error("Alias not created");
  await p.emailAlias.create({data:{organizationId:box.organizationId,source,destination:box.address,stalwartAliasId:id}});
 }
 const domains=await j([["x:Domain/get",{ids:[box.domain.stalwartDomainId],properties:["dkimManagement"]},"d"]]);
 const management=domains[0][1].list[0].dkimManagement;
 // Retain automatic RSA rotation and all existing timing settings; keep Ed25519 DNS for historical messages.
 await j([["x:Domain/set",{update:{[box.domain.stalwartDomainId]:{dkimManagement:{...management,algorithms:{Dkim1RsaSha256:true}}}}},"d"]]);
 const q=await j([["x:DkimSignature/query",{filter:{domainId:box.domain.stalwartDomainId}},"q"]]);
 const k=await j([["x:DkimSignature/get",{ids:q[0][1].ids,properties:["@type","stage","selector"]},"k"]]);
 const updates=Object.fromEntries(k[0][1].list.filter(key=>key["@type"]==="Dkim1Ed25519Sha256" && key.stage==="active").map(key=>[key.id,{stage:"retired",nextTransitionAt:null}]));
 if(Object.keys(updates).length)await j([["x:DkimSignature/set",{update:updates},"s"]]);
 await j([["x:Action/set",{create:{reload:{"@type":"ReloadSettings"}}},"a"]]);
 await p.domain.update({where:{id:box.domain.id},data:{replyToAddress:`reply@${domain}`}});
 console.log(JSON.stringify({mailbox:box.address,aliases:["abuse","dmarc","reply"],owner:user.email,dkim:"RSA only; automatic rotation retained"}));
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());
